import React, { useState, useEffect, useRef, useCallback } from 'react';
import Papa from 'papaparse';
import { db, auth } from './firebase';
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth';
import {
  ref,
  onValue,
  update,
  set,
  get,
  push,
  increment,
  remove,
  onDisconnect,
  runTransaction,
} from 'firebase/database';
import { STUDENTS } from './students';

const QUESTION_TIME = 15;
const QUESTION_COUNT = 10;
const ROOM_TIMEOUT_MS = 45000;
const HEARTBEAT_MS = 5000;
const REVEAL_MS = 1200;
const AUTH_EMAIL_DOMAIN = 'sshes.tyc.edu.tw';
const TOTAL_TABLES = 14;

const AI_AVATAR_SRC = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
  <rect width="160" height="160" rx="80" fill="#1e1e1e"/>
  <circle cx="80" cy="80" r="70" fill="#2d2d2d" stroke="#ffeb3b" stroke-width="6"/>
  <text x="80" y="92" font-size="44" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-weight="bold">AI</text>
</svg>
`)}`;

function App() {
  const [user, setUser] = useState(null);
  const [loginId, setLoginId] = useState('');
  const [loginPwd, setLoginPwd] = useState('');
  const [view, setView] = useState('login');
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [inputMsg, setInputMsg] = useState('');
  const [questionStatsList, setQuestionStatsList] = useState([]);
  const [roomStatusMap, setRoomStatusMap] = useState({});

  const [roomId, setRoomId] = useState('');
  const [myRole, setMyRole] = useState('viewer');
  const [p2Joined, setP2Joined] = useState(false);
  const [isAiMode, setIsAiMode] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [allQuestions, setAllQuestions] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selections, setSelections] = useState(null);
  const [timeLeft, setTimeLeft] = useState(QUESTION_TIME);
  const [questionEndsAt, setQuestionEndsAt] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);
  const [p1Name, setP1Name] = useState('');
  const [p2Name, setP2Name] = useState('');
  const [p1Id, setP1Id] = useState('');
  const [p2Id, setP2Id] = useState('');
  const [roomData, setRoomData] = useState(null);

  const isSwitching = useRef(false);
  const roomDataRef = useRef(null);
  const gameOverPlayedRef = useRef(false);
  const rewardClaimingRef = useRef(false);
  const advanceTimerRef = useRef(null);
  const advanceLockRef = useRef('');

  const BASE = import.meta.env.BASE_URL;
  const lobbyBgm = useRef(new Audio(`${BASE}sounds/lobby.mp3`));
  const gameBgm = useRef(new Audio(`${BASE}sounds/game.mp3`));
  const aiBgm = useRef(new Audio(`${BASE}sounds/ai.mp3`));
  const correctSfx = useRef(new Audio(`${BASE}sounds/correct.mp3`));
  const wrongSfx = useRef(new Audio(`${BASE}sounds/wrong.mp3`));
  const winSfx = useRef(new Audio(`${BASE}sounds/win.mp3`));
  const loseSfx = useRef(new Audio(`${BASE}sounds/lose.mp3`));

  const stopAllAudio = useCallback(() => {
    [lobbyBgm, gameBgm, aiBgm, correctSfx, wrongSfx, winSfx, loseSfx].forEach((s) => {
      s.current.pause();
      s.current.currentTime = 0;
    });
  }, []);

  const avatarSrc = useCallback(
    (studentId, size = 40) => {
      if (!studentId) return `https://via.placeholder.com/${size}`;
      if (studentId === 'ai') return AI_AVATAR_SRC;
      return `${BASE}avatars/${String(studentId).trim()}.jpg`;
    },
    [BASE]
  );

  const dbSet = async (path, data) => {
    try {
      await set(ref(db, path), data);
    } catch (err) {
      console.error('SET FAIL ->', path, err);
      throw err;
    }
  };

  const dbUpdate = async (path, data) => {
    try {
      await update(ref(db, path), data);
    } catch (err) {
      console.error('UPDATE FAIL ->', path, err);
      throw err;
    }
  };

  const dbRemove = async (path) => {
    try {
      await remove(ref(db, path));
    } catch (err) {
      console.error('REMOVE FAIL ->', path, err);
      throw err;
    }
  };

  const dbPush = async (path, data) => {
    try {
      return await push(ref(db, path), data);
    } catch (err) {
      console.error('PUSH FAIL ->', path, err);
      throw err;
    }
  };

  const dbTx = async (path, updater) => {
    try {
      return await runTransaction(ref(db, path), updater);
    } catch (err) {
      console.error('TX FAIL ->', path, err);
      throw err;
    }
  };

  const dbRootUpdate = async (updates) => {
    try {
      await update(ref(db), updates);
    } catch (err) {
      console.error('ROOT UPDATE FAIL ->', updates, err);
      throw err;
    }
  };

  const calcWinRate = (w = 0, l = 0) => {
    const total = (w || 0) + (l || 0);
    return total === 0 ? '0%' : `${((w / total) * 100).toFixed(1)}%`;
  };

  const formatMessageTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${hh}-${mm}-${month}-${day}`;
  };

  const shuffleQuestions = useCallback((source) => {
    const arr = [...source];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, QUESTION_COUNT);
  }, []);

  const questionKeyOf = (text = '') => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };

  const isAliveByUid = (room, uid) => {
    if (!uid) return false;
    if (uid === 'ai') return true;
    const ts = room?.presence?.[uid]?.ts || 0;
    if (!ts) return false;
    return Date.now() - ts <= HEARTBEAT_MS * 3;
  };

  const getRoomDisplayStatus = (room) => {
    if (
      !room ||
      room.gameOver ||
      !room.p1Uid ||
      Date.now() - (room.lastActive || 0) > ROOM_TIMEOUT_MS
    ) {
      return { count: 0, label: '空房', bg: '#2c2c2c', border: '#444' };
    }
    const p1Alive = isAliveByUid(room, room.p1Uid);
    const p2Alive = isAliveByUid(room, room.p2Uid);
    const aliveCount = (p1Alive ? 1 : 0) + (p2Alive ? 1 : 0);
    if (aliveCount <= 0) {
      return { count: 0, label: '空房', bg: '#2c2c2c', border: '#444' };
    }
    if (aliveCount === 1) {
      return { count: 1, label: '1人', bg: '#8a6d1f', border: '#ffeb3b' };
    }
    return { count: 2, label: '已滿', bg: '#7f1d1d', border: '#ff5252' };
  };

  const recordQuestionStat = async (questionObj, isCorrect) => {
    if (!questionObj?.question) return;
    if (user?.isTeacher) return;
    const key = questionKeyOf(questionObj.question);
    const correctAnswer =
      questionObj.options?.find((o) => o.isCorrect)?.text || '';
    await dbTx(`questionStats/${key}`, (stat) => {
      const current = stat || {
        question: questionObj.question,
        correctAnswer,
        attempts: 0,
        wrongs: 0,
        updatedAt: 0,
      };
      const prevAttempts = current.attempts ?? current.totalCount ?? 0;
      const prevWrongs = current.wrongs ?? current.wrongCount ?? 0;
      return {
        ...current,
        question: questionObj.question,
        correctAnswer: current.correctAnswer || correctAnswer,
        attempts: prevAttempts + 1,
        wrongs: prevWrongs + (isCorrect ? 0 : 1),
        totalCount: prevAttempts + 1,
        wrongCount: prevWrongs + (isCorrect ? 0 : 1),
        updatedAt: Date.now(),
      };
    });
  };

  const resetGameState = useCallback(() => {
    stopAllAudio();
    setRoomId('');
    setMyRole('viewer');
    setP2Joined(false);
    setIsAiMode(false);
    setQuestions([]);
    setCurrentIdx(0);
    setSelections(null);
    setTimeLeft(QUESTION_TIME);
    setQuestionEndsAt(0);
    setGameOver(false);
    setP1Score(0);
    setP2Score(0);
    setP1Name('');
    setP2Name('');
    setP1Id('');
    setP2Id('');
    setRoomData(null);
    isSwitching.current = false;
    gameOverPlayedRef.current = false;
    rewardClaimingRef.current = false;
    advanceLockRef.current = '';
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }, [stopAllAudio]);

  const roomCurrentIdx = roomData?.currentIdx ?? 0;
  const roomGameOver = !!roomData?.gameOver;
  const p1Answered = !!roomData?.selections?.p1;
  const p2Answered = !!roomData?.selections?.p2;
  const bothAnswered = p1Answered && p2Answered;

  useEffect(() => {
    roomDataRef.current = roomData;
  }, [roomData]);

  useEffect(() => {
    [lobbyBgm, gameBgm, aiBgm].forEach((bgm) => {
      bgm.current.loop = true;
      bgm.current.volume = 0.4;
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    stopAllAudio();
    if (view === 'lobby') {
      lobbyBgm.current.play().catch(console.error);
    } else if (view === 'game') {
      if (isAiMode) aiBgm.current.play().catch(console.error);
      else gameBgm.current.play().catch(console.error);
    }
  }, [view, isAiMode, user, stopAllAudio]);

  useEffect(() => {
    fetch(`${BASE}quiz.csv`)
      .then((res) => res.text())
      .then((result) => {
        Papa.parse(result, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => {
            const formatted = res.data
              .filter((r) => r.question)
              .map((r) => ({
                question: r.question,
                category: r.category || '',
                options: [
                  { text: r.option1, isCorrect: String(r.correct) === '1' },
                  { text: r.option2, isCorrect: String(r.correct) === '2' },
                  { text: r.option3, isCorrect: String(r.correct) === '3' },
                  { text: r.option4, isCorrect: String(r.correct) === '4' },
                ].filter((o) => o.text),
              }));
            setAllQuestions(formatted);
            setLoading(false);
          },
        });
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, [BASE]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) {
        setUser(null);
        resetGameState();
        setView('login');
        return;
      }
      try {
        const uid = fbUser.uid;
        const inferredStudentId = fbUser.email?.split('@')[0] || '';
        const student = STUDENTS.find((s) => s.id === inferredStudentId);
        const userRef = ref(db, `users/${uid}`);
        const snap = await get(userRef);
        const baseUserData = {
          studentId: inferredStudentId,
          name: student?.name || inferredStudentId,
          totalScore: 0,
          hp: 20,
          wins: 0,
          losses: 0,
          isTeacher: inferredStudentId === 'teacher',
        };
        let finalUserData = baseUserData;
        if (!snap.exists()) {
          await dbSet(`users/${uid}`, baseUserData);
        } else {
          finalUserData = {
            ...baseUserData,
            ...snap.val(),
            studentId: snap.val().studentId || inferredStudentId,
            name: snap.val().name || student?.name || inferredStudentId,
          };
        }
        setUser({ uid, ...finalUserData });
        setView((prev) => (prev === 'login' ? 'lobby' : prev));
      } catch (err) {
        console.error(err);
      }
    });
    return () => unsub();
  }, [resetGameState]);

  useEffect(() => {
    if (!user?.uid) return;
    const offUsers = onValue(
      ref(db, 'users'),
      (snap) => {
        const val = snap.val() || {};
        const list = Object.entries(val)
          .map(([uid, v]) => ({ uid, ...v }))
          .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
          .slice(0, 15);
        setLeaderboard(list);
        const me = val[user.uid];
        if (me) {
          setUser((prev) => ({
            ...prev,
            ...me,
            uid: prev.uid,
            studentId: me.studentId || prev.studentId,
          }));
        }
      },
      console.error
    );
    const offMessages = onValue(
      ref(db, 'messages'),
      (snap) => {
        const val = snap.val() || {};
        const list = Object.values(val).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        setMessages(list);
      },
      console.error
    );
    return () => {
      offUsers();
      offMessages();
    };
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid || user?.isTeacher) {
      setRoomStatusMap({});
      return;
    }
    const offRooms = onValue(
      ref(db, 'rooms'),
      (snap) => {
        const val = snap.val() || {};
        const nextMap = {};
        for (let i = 1; i <= TOTAL_TABLES; i += 1) {
          const tid = `Table_${i}`;
          nextMap[tid] = getRoomDisplayStatus(val[tid]);
        }
        setRoomStatusMap(nextMap);
      },
      console.error
    );
    return () => offRooms();
  }, [user?.uid, user?.isTeacher]);

  useEffect(() => {
    if (!user?.uid || !user?.isTeacher) {
      setQuestionStatsList([]);
      return;
    }
    const offStats = onValue(
      ref(db, 'questionStats'),
      (snap) => {
        const val = snap.val() || {};
        const list = Object.entries(val)
          .map(([id, v]) => {
            const attempts = v.attempts ?? v.totalCount ?? 0;
            const wrongs = v.wrongs ?? v.wrongCount ?? 0;
            return {
              id,
              ...v,
              attempts,
              wrongs,
              correctAnswer: v.correctAnswer || '',
              wrongRate: attempts > 0 ? wrongs / attempts : 0,
            };
          })
          .filter((v) => v.attempts > 0)
          .sort((a, b) => {
            if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
            if (b.wrongs !== a.wrongs) return b.wrongs - a.wrongs;
            return b.attempts - a.attempts;
          })
          .slice(0, 20);
        setQuestionStatsList(list);
      },
      console.error
    );
    return () => offStats();
  }, [user?.uid, user?.isTeacher]);

  const handleLogin = async () => {
    const student = STUDENTS.find((s) => s.id === loginId);
    if (!student) {
      alert('找不到此學號！');
      return;
    }
    const email = `${loginId}@${AUTH_EMAIL_DOMAIN}`;
    try {
      const cred = await signInWithEmailAndPassword(auth, email, loginPwd);
      const uid = cred.user.uid;
      const userRef = ref(db, `users/${uid}`);
      const snap = await get(userRef);
      const baseUserData = {
        studentId: student.id,
        name: student.name,
        totalScore: 0,
        hp: 20,
        wins: 0,
        losses: 0,
        isTeacher: student.id === 'teacher',
      };
      let finalUserData = baseUserData;
      if (!snap.exists()) {
        await dbSet(`users/${uid}`, baseUserData);
      } else {
        finalUserData = {
          ...baseUserData,
          ...snap.val(),
        };
        await dbUpdate(`users/${uid}`, {
          studentId: student.id,
          name: student.name,
          isTeacher: student.id === 'teacher',
        });
      }
      resetGameState();
      setUser({ uid, ...finalUserData });
      setView('lobby');
    } catch (err) {
      console.error(err);
      alert('學號或密碼錯誤！');
    }
  };

  const startAiGame = async () => {
    if (Number(user?.hp) < 4) {
      alert('HP 不足 4 點！');
      return;
    }
    if (!allQuestions.length) return;
    const tid = `AI_${user.studentId}_${Date.now()}`;
    const shuffled = shuffleQuestions(allQuestions);
    const now = Date.now();
    await dbSet(`rooms/${tid}`, {
      roomType: 'ai',
      p1: user.name,
      p1Uid: user.uid,
      p1Id: user.studentId,
      p2: '🤖 練習用 AI',
      p2Uid: 'ai',
      p2Id: 'ai',
      roomQuestions: shuffled,
      currentIdx: 0,
      questionEndsAt: now + QUESTION_TIME * 1000,
      scores: { p1: 0, p2: 0 },
      selections: null,
      gameOver: false,
      createdAt: now,
      lastActive: now,
      rewardClaimed: {},
      presence: {},
    }).catch(console.error);
    await dbUpdate(`users/${user.uid}`, { hp: increment(-4) }).catch(console.error);
    setQuestions(shuffled);
    setMyRole('p1');
    setRoomId(tid);
    setIsAiMode(true);
    setP2Joined(true);
    setP1Name(user.name);
    setP1Id(user.studentId);
    setP2Name('🤖 練習用 AI');
    setP2Id('ai');
    setView('game');
  };

  const handleJoinTable = async (num) => {
    if (Number(user?.hp) < 2) {
      alert('HP 不足 2 點！');
      return;
    }
    if (!allQuestions.length) return;
    const tid = `Table_${num}`;
    const shuffled = shuffleQuestions(allQuestions);
    const now = Date.now();
    const createFreshRoom = () => ({
      roomType: 'pvp',
      p1: user.name,
      p1Uid: user.uid,
      p1Id: user.studentId,
      p2: null,
      p2Uid: null,
      p2Id: null,
      roomQuestions: shuffled,
      currentIdx: 0,
      questionEndsAt: now + QUESTION_TIME * 1000,
      scores: { p1: 0, p2: 0 },
      selections: null,
      gameOver: false,
      createdAt: now,
      lastActive: now,
      finishedAt: null,
      rewardClaimed: {},
      presence: { [user.uid]: { online: true, ts: now } },
    });
    let result;
    try {
      result = await dbTx(`rooms/${tid}`, (room) => {
        if (!room) return createFreshRoom();
        const p1Alive = isAliveByUid(room, room.p1Uid);
        const p2Alive = isAliveByUid(room, room.p2Uid);
        const noLivePlayers = !p1Alive && !p2Alive;
        const roomExpired = room.gameOver || !room.p1Uid || noLivePlayers || now - (room.lastActive || 0) > ROOM_TIMEOUT_MS;
        if (roomExpired) return createFreshRoom();
        if (room.p1Uid === user.uid || room.p2Uid === user.uid) {
          return {
            ...room,
            lastActive: now,
            presence: { ...(room.presence || {}), [user.uid]: { online: true, ts: now } },
          };
        }
        if (!room.p2Uid || !p2Alive) {
          return {
            ...room,
            p2: user.name,
            p2Uid: user.uid,
            p2Id: user.studentId,
            lastActive: now,
            presence: { ...(room.presence || {}), [user.uid]: { online: true, ts: now } },
          };
        }
        return room;
      });
    } catch (err) {
      console.error(err);
      alert('進房失敗，請再試一次');
      return;
    }
    
    // 修正：從交易結果中取得正確的 room 資料 [cite: 869]
    const finalRoom = result.snapshot.val();
    const role = finalRoom.p1Uid === user.uid ? 'p1' : finalRoom.p2Uid === user.uid ? 'p2' : null;
    
    if (!role) {
      alert('此房間已滿或房間狀態尚未清除，請換桌或稍後再試');
      return;
    }
    await dbSet(`rooms/${tid}/presence/${user.uid}`, { online: true, ts: Date.now() }).catch(console.error);
    await dbUpdate(`rooms/${tid}`, { lastActive: Date.now() }).catch(console.error);
    await dbUpdate(`users/${user.uid}`, { hp: increment(-2) }).catch(console.error);
    setMyRole(role);
    setRoomId(tid);
    setQuestions(finalRoom.roomQuestions || []);
    setIsAiMode(false);
    setP2Joined(!!finalRoom.p2Uid);
    setView('game');
  };

  useEffect(() => {
    if (!roomId || !user?.uid) return;
    const roomRef = ref(db, `rooms/${roomId}`);
    const offRoom = onValue(
      roomRef,
      (snap) => {
        const data = snap.val();
        if (!data) {
          if (view === 'game') {
            stopAllAudio();
            resetGameState();
            setView('lobby');
          }
          return;
        }
        const roleFromDb = data.p1Uid === user.uid ? 'p1' : data.p2Uid === user.uid ? 'p2' : null;
        if (!roleFromDb) {
          stopAllAudio();
          resetGameState();
          setView('lobby');
          return;
        }
        setRoomData(data);
        setMyRole(roleFromDb);
        setP1Name(data.p1 || '');
        setP1Id(data.p1Id || '');
        setP2Name(data.p2 || '等待中...');
        setP2Id(data.p2Id || '');
        setP2Joined(!!data.p2Uid);
        setSelections(data.selections || null);
        setCurrentIdx(data.currentIdx || 0);
        setQuestionEndsAt(data.questionEndsAt || 0);
        setGameOver(!!data.gameOver);
        if (data.scores) {
          setP1Score(data.scores.p1 || 0);
          setP2Score(data.scores.p2 || 0);
        }
        if (data.roomQuestions) setQuestions(data.roomQuestions);
        if (data.gameOver && !gameOverPlayedRef.current) {
          const myFinal = roleFromDb === 'p1' ? data.scores?.p1 || 0 : data.scores?.p2 || 0;
          const oppFinal = roleFromDb === 'p1' ? data.scores?.p2 || 0 : data.scores?.p1 || 0;
          [aiBgm, gameBgm].forEach((b) => b.current.pause());
          if (myFinal > oppFinal) winSfx.current.play().catch(console.error);
          else loseSfx.current.play().catch(console.error);
          gameOverPlayedRef.current = true;
        }
        if (!data.gameOver) gameOverPlayedRef.current = false;
      },
      console.error
    );
    return () => offRoom();
  }, [roomId, user?.uid, view, resetGameState, stopAllAudio]);

  useEffect(() => {
    if (!roomId || !user?.uid || view !== 'game') return;
    const presencePath = `rooms/${roomId}/presence/${user.uid}`;
    const presenceRef = ref(db, presencePath);
    const disconnectOp = onDisconnect(presenceRef);
    dbSet(presencePath, { online: true, ts: Date.now() }).catch(console.error);
    disconnectOp.remove().catch(console.error);
    if (isAiMode) {
      return () => {
        disconnectOp.cancel().catch(console.error);
        dbRemove(presencePath).catch(console.error);
      };
    }
    const timer = setInterval(() => {
      dbSet(presencePath, { online: true, ts: Date.now() }).catch(console.error);
      dbUpdate(`rooms/${roomId}`, { lastActive: Date.now() }).catch(console.error);
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      disconnectOp.cancel().catch(console.error);
      dbRemove(presencePath).catch(console.error);
    };
  }, [roomId, user?.uid, view, isAiMode]);

  useEffect(() => {
    if (!questionEndsAt || gameOver || (!p2Joined && !isAiMode)) {
      setTimeLeft(QUESTION_TIME);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((questionEndsAt - Date.now()) / 1000));
      setTimeLeft(left);
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [questionEndsAt, gameOver, p2Joined, isAiMode]);

  const advanceToNextQuestion = useCallback(
    async (expectedIdx) => {
      if (!roomId) return;
      try {
        await dbTx(`rooms/${roomId}`, (room) => {
          if (!room || room.gameOver) return room;
          if ((room.currentIdx || 0) !== expectedIdx) return room;
          if (!room.selections?.p1 || !room.selections?.p2) return room;
          const nextIdx = expectedIdx + 1;
          if (nextIdx >= (room.roomQuestions?.length || QUESTION_COUNT)) {
            return { ...room, gameOver: true, finishedAt: Date.now(), lastActive: Date.now() };
          }
          return {
            ...room,
            currentIdx: nextIdx,
            selections: null,
            questionEndsAt: Date.now() + QUESTION_TIME * 1000,
            lastActive: Date.now(),
          };
        });
      } catch (err) {
        console.error('advanceToNextQuestion failed:', err);
      }
    },
    [roomId]
  );

  useEffect(() => {
    if (!roomId || myRole === 'viewer' || !roomData || roomGameOver) return;
    if (!bothAnswered) return;
    const key = `${roomId}-${roomCurrentIdx}`;
    if (advanceLockRef.current === key) return;
    advanceLockRef.current = key;
    isSwitching.current = true;
    const timerId = setTimeout(async () => {
      advanceTimerRef.current = null;
      await advanceToNextQuestion(roomCurrentIdx);
    }, REVEAL_MS);
    advanceTimerRef.current = timerId;
    return () => {
      clearTimeout(timerId);
      if (advanceTimerRef.current === timerId) advanceTimerRef.current = null;
      if ((roomDataRef.current?.currentIdx ?? 0) === roomCurrentIdx) {
        isSwitching.current = false;
        advanceLockRef.current = '';
      }
    };
  }, [roomId, myRole, roomCurrentIdx, roomGameOver, bothAnswered, advanceToNextQuestion, roomData]);

  useEffect(() => {
    advanceLockRef.current = '';
    isSwitching.current = false;
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }, [currentIdx, roomId]);

  useEffect(() => {
    if (!roomId || myRole === 'viewer' || !roomData || roomGameOver) return;
    if (isSwitching.current) return;
    if (!questionEndsAt) return;
    if (bothAnswered) return;
    const myAnswered = myRole === 'p1' ? p1Answered : p2Answered;
    const oppUid = myRole === 'p1' ? roomData.p2Uid : roomData.p1Uid;
    const oppAlive = isAliveByUid(roomData, oppUid);
    const shouldForceAdvance = myAnswered && oppUid && !oppAlive;
    if (!shouldForceAdvance && Date.now() < questionEndsAt) return;
    isSwitching.current = true;
    dbTx(`rooms/${roomId}`, (room) => {
      if (!room || room.gameOver) return room;
      const roomMyRole = room.p1Uid === user.uid ? 'p1' : room.p2Uid === user.uid ? 'p2' : null;
      if (!roomMyRole) return room;
      const roomMyAnswered = roomMyRole === 'p1' ? !!room.selections?.p1 : !!room.selections?.p2;
      const roomOppUid = roomMyRole === 'p1' ? room.p2Uid : room.p1Uid;
      const roomOppAlive = isAliveByUid(room, roomOppUid);
      if (!roomMyAnswered && Date.now() < (room.questionEndsAt || 0)) return room;
      if (roomMyAnswered && roomOppAlive && Date.now() < (room.questionEndsAt || 0)) return room;
      const alreadyBothAnswered = !!room.selections?.p1 && !!room.selections?.p2;
      if (alreadyBothAnswered) return room;
      const nextSelections = { ...(room.selections || {}) };
      if (!nextSelections.p1) nextSelections.p1 = { text: '', isCorrect: false, timedOut: true };
      if (!nextSelections.p2) nextSelections.p2 = { text: '', isCorrect: false, timedOut: true };
      const nextIdx = (room.currentIdx || 0) + 1;
      if (nextIdx >= (room.roomQuestions?.length || QUESTION_COUNT)) {
        return { ...room, selections: nextSelections, gameOver: true, finishedAt: Date.now(), lastActive: Date.now() };
      }
      return { ...room, selections: null, currentIdx: nextIdx, questionEndsAt: Date.now() + QUESTION_TIME * 1000, lastActive: Date.now() };
    })
      .catch(console.error)
      .finally(() => { isSwitching.current = false; });
  }, [roomId, myRole, roomData, roomGameOver, questionEndsAt, bothAnswered, p1Answered, p2Answered, user?.uid]);

  useEffect(() => {
    if (!isAiMode || !roomId || roomGameOver) return;
    if (!p1Answered || p2Answered) return;
    const expectedIdx = roomCurrentIdx;
    const timer = setTimeout(async () => {
      const q = roomDataRef.current?.roomQuestions?.[expectedIdx];
      if (!q) return;
      const correctOpt = q.options.find((o) => o.isCorrect);
      const wrongOpts = q.options.filter((o) => !o.isCorrect);
      const aiOpt = Math.random() < 0.6 ? correctOpt : wrongOpts[Math.floor(Math.random() * wrongOpts.length)] || correctOpt;
      await dbTx(`rooms/${roomId}`, (room) => {
        if (!room || room.gameOver) return room;
        if ((room.currentIdx || 0) !== expectedIdx) return room;
        if (room.selections?.p2) return room;
        const gained = aiOpt?.isCorrect ? 10 : 0;
        return {
          ...room,
          selections: { ...(room.selections || {}), p2: { text: aiOpt?.text || '', isCorrect: !!aiOpt?.isCorrect } },
          scores: { ...(room.scores || { p1: 0, p2: 0 }), p2: (room.scores?.p2 || 0) + gained },
          lastActive: Date.now(),
        };
      }).catch(console.error);
    }, 800);
    return () => clearTimeout(timer);
  }, [isAiMode, roomId, roomGameOver, roomCurrentIdx, p1Answered, p2Answered]);

  const onSelect = async (opt) => {
    if (!roomId || !user?.uid || gameOver || (!p2Joined && !isAiMode) || selections?.[myRole]) return;
    if (opt.isCorrect) {
      correctSfx.current.currentTime = 0;
      correctSfx.current.play().catch(console.error);
    } else {
      wrongSfx.current.currentTime = 0;
      wrongSfx.current.play().catch(console.error);
    }
    const result = await dbTx(`rooms/${roomId}`, (room) => {
      if (!room || room.gameOver) return room;
      const role = room.p1Uid === user.uid ? 'p1' : room.p2Uid === user.uid ? 'p2' : null;
      if (!role || room.selections?.[role] || Date.now() > (room.questionEndsAt || 0)) return room;
      const left = Math.max(0, Math.ceil(((room.questionEndsAt || 0) - Date.now()) / 1000));
      const gained = opt.isCorrect ? (left >= 13 ? 20 : 10) + Math.floor(left * 0.5) : 0;
      return {
        ...room,
        selections: { ...(room.selections || {}), [role]: { text: opt.text, isCorrect: !!opt.isCorrect } },
        scores: { ...(room.scores || { p1: 0, p2: 0 }), [role]: (room.scores?.[role] || 0) + gained },
        lastActive: Date.now(),
      };
    }).catch(console.error);
    if (result?.committed) {
      await recordQuestionStat(questions[currentIdx], !!opt.isCorrect).catch(console.error);
    }
  };

  const finishGameAndGoLobby = async () => {
    if (!user?.uid || rewardClaimingRef.current) return;
    rewardClaimingRef.current = true;
    const myScore = myRole === 'p1' ? p1Score : p2Score;
    const oppScore = myRole === 'p1' ? p2Score : p1Score;
    const isWin = myScore > oppScore;
    let rewardPoints = isAiMode ? (isWin ? Math.floor(myScore * 0.5) : Math.floor(myScore * 0.3)) : (isWin ? myScore : Math.floor(myScore * 0.8));
    const updates = {};
    updates[`users/${user.uid}/totalScore`] = increment(rewardPoints);
    if (!isAiMode) {
      updates[`users/${user.uid}/wins`] = increment(isWin ? 1 : 0);
      updates[`users/${user.uid}/losses`] = increment(isWin ? 0 : 1);
      if (isWin) updates[`users/${user.uid}/hp`] = increment(5);
    }
    await dbRootUpdate(updates).catch(console.error);
    if (roomId) await dbRemove(`rooms/${roomId}`).catch(console.error);
    stopAllAudio();
    resetGameState();
    setView('lobby');
  };

  const sendMessage = async () => {
    if (!user || !inputMsg.trim()) return;
    await dbPush('messages', { user: user.name, text: inputMsg.trim(), timestamp: Date.now() }).catch(console.error);
    setInputMsg('');
  };

  const renderMessageBoard = (compact = false) => (
    <div className="box" style={{ marginTop: compact ? '12px' : 0 }}>
      <h4 style={{ marginTop: 0 }}>💬 留言板 (最新在上方)</h4>
      <div className="msg-box" style={{ height: compact ? '220px' : '300px' }}>
        {messages.slice().reverse().map((m, i) => (
          <div key={`${m.timestamp || 0}-${i}`} style={{ marginBottom: '8px', borderBottom: '1px solid #222', paddingBottom: '4px', wordBreak: 'break-word', lineHeight: 1.6 }}>
            <span><b style={{ color: '#4caf50' }}>{m.user}</b>: {m.text} <span style={{ color: '#888', marginLeft: '8px', fontSize: '0.85em' }}>{formatMessageTime(m.timestamp)}</span></span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '5px' }}>
        <input value={inputMsg} onChange={(e) => setInputMsg(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') sendMessage(); }} style={{ flex: 1, padding: '10px', borderRadius: '8px', background: '#333', border: 'none', color: 'white', minWidth: 0 }} placeholder="輸入聊天..." />
        <button onClick={sendMessage} className="btn" style={{ background: '#4caf50', color: 'white', flexShrink: 0 }}>發送</button>
      </div>
    </div>
  );

  const renderLobby = () => (
    <div className="lobby-layout">
      <div className="sidebar">
        <div className="box">
          <h3>🏆 排行榜</h3>
          <table className="rank-table">
            <thead><tr><th>排名</th><th>玩家</th><th>積分</th><th>勝率</th></tr></thead>
            <tbody>
              {leaderboard.map((p, i) => (
                <tr key={p.uid} style={{ background: p.uid === user.uid ? 'rgba(76,175,80,0.1)' : 'transparent' }}>
                  <td>{i + 1}</td>
                  <td style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><img className="avatar" src={avatarSrc(p.studentId)} alt="" /> {p.name}</td>
                  <td>{p.totalScore || 0}</td>
                  <td>{calcWinRate(p.wins, p.losses)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {renderMessageBoard()}
      </div>
      <div className="main-content">
        <div className="box" style={{ display: 'flex', gap: '15px', alignItems: 'center' }}>
          <button onClick={startAiGame} className="btn" style={{ background: '#2196f3', color: 'white', flex: 1, fontSize: '1.1rem', padding: '20px' }}>🤖 練習對戰 (需 4 HP)</button>
        </div>
        <div className="box">
          <h3 style={{ marginTop: 0 }}>⚔️ 線上對戰 (需 2 HP)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '15px' }}>
            {Array.from({ length: TOTAL_TABLES }, (_, i) => {
              const tid = `Table_${i + 1}`;
              const status = roomStatusMap[tid] || { label: '讀取中', bg: '#222', border: '#333' };
              return (
                <button
                  key={tid}
                  onClick={() => handleJoinTable(i + 1)}
                  style={{
                    background: status.bg,         // 新增：呈現不同人數顏色 [cite: 836]
                    border: `2px solid ${status.border}`, // 新增：呈現不同人數邊框 [cite: 836]
                    padding: '20px',
                    borderRadius: '12px',
                    color: 'white',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '8px'
                  }}
                >
                  <span style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>第 {i + 1} 桌</span>
                  <span style={{ fontSize: '0.9rem', opacity: 0.9 }}>{status.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  // 渲染登入與遊戲畫面... (由於篇幅限制，以下為關鍵結構省略)
  if (loading) return <div style={{ color: 'white', textAlign: 'center', marginTop: '50px' }}>載入中...</div>;

  return (
    <div className="safe-container">
      <style>{/* 略：CSS 樣式 [cite: 728, 735] */}</style>
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src={avatarSrc(user?.studentId)} className="avatar" alt="" />
          <div><b>{user?.name}</b> <span style={{ color: '#ff5252' }}>❤️ HP: {user?.hp}</span></div>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="btn" onClick={() => signOut(auth)} style={{ background: '#555', color: 'white' }}>登出</button>
        </div>
      </header>

      {view === 'login' && (
        <div className="box" style={{ maxWidth: '400px', margin: '100px auto', textAlign: 'center' }}>
          <h2>登入遊戲</h2>
          <input className="btn" style={{ background: '#333', color: 'white', width: '100%', marginBottom: '10px' }} placeholder="學號" value={loginId} onChange={e => setLoginId(e.target.value)} />
          <input className="btn" type="password" style={{ background: '#333', color: 'white', width: '100%', marginBottom: '10px' }} placeholder="密碼" value={loginPwd} onChange={e => setLoginPwd(e.target.value)} />
          <button className="btn" style={{ background: '#4caf50', color: 'white', width: '100%' }} onClick={handleLogin}>登入</button>
        </div>
      )}

      {view === 'lobby' && renderLobby()}

      {view === 'game' && (
        <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
          {/* 略：遊戲對戰 UI (問題、選項、計分) */}
          {questions[currentIdx] && (
            <div className="box">
              <h2>第 {currentIdx + 1} 題 ({timeLeft}s)</h2>
              <p style={{ fontSize: '1.3rem' }}>{questions[currentIdx].question}</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                {questions[currentIdx].options.map((opt, i) => (
                  <button key={i} onClick={() => onSelect(opt)} className="option-btn" style={{ background: selections?.[myRole]?.text === opt.text ? '#2196f3' : '#333' }}>
                    {opt.text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {gameOver && (
            <div className="box" style={{ textAlign: 'center' }}>
              <h2>遊戲結束！</h2>
              <button className="btn" onClick={finishGameAndGoLobby} style={{ background: '#4caf50', color: 'white' }}>回到大廳並領取獎勵</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;