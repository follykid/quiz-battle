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
  const [debugTable1, setDebugTable1] = useState(null);

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
    return ts > 0 && Date.now() - ts <= HEARTBEAT_MS * 3;
  };

  const getRoomDisplayStatus = (room) => {
    const emptyStatus = {
      count: 0,
      label: '空房',
      people: '0/2人',
      bg: '#2c2c2c',
      border: '#555',
      shadow: 'rgba(255,255,255,0.06)',
    };

    if (!room || room.gameOver || !room.p1Uid) {
      return emptyStatus;
    }

    const occupiedCount = (room.p1Uid ? 1 : 0) + (room.p2Uid ? 1 : 0);

    if (occupiedCount === 1) {
      return {
        count: 1,
        label: '待加入',
        people: '1/2人',
        bg: '#8a6d1f',
        border: '#ffeb3b',
        shadow: 'rgba(255,235,59,0.35)',
      };
    }

    if (occupiedCount >= 2) {
      return {
        count: 2,
        label: '已滿',
        people: '2/2人',
        bg: '#7f1d1d',
        border: '#ff5252',
        shadow: 'rgba(255,82,82,0.35)',
      };
    }

    return emptyStatus;
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

        setUser({
          uid,
          ...finalUserData,
        });
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
    const off = onValue(
      ref(db, 'rooms/Table_1'),
      (snap) => {
        const val = snap.val() || null;
        console.log('DEBUG rooms/Table_1 =>', val);
        setDebugTable1(val);
      },
      console.error
    );

    return () => off();
  }, []);

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
      setUser({
        uid,
        ...finalUserData,
      });
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
      presence: {
        [user.uid]: { online: true, ts: now },
      },
    });

    let result;
    try {
      result = await dbTx(`rooms/${tid}`, (room) => {
        if (!room) {
          return createFreshRoom();
        }

        const p1Alive = isAliveByUid(room, room.p1Uid);
        const p2Alive = isAliveByUid(room, room.p2Uid);
        const noLivePlayers = !p1Alive && !p2Alive;
        const roomExpired =
          room.gameOver ||
          !room.p1Uid ||
          noLivePlayers ||
          now - (room.lastActive || 0) > ROOM_TIMEOUT_MS;

        if (roomExpired) {
          return createFreshRoom();
        }

        if (room.p1Uid === user.uid || room.p2Uid === user.uid) {
          return {
            ...room,
            lastActive: now,
            presence: {
              ...(room.presence || {}),
              [user.uid]: { online: true, ts: now },
            },
          };
        }

        if (!room.p2Uid || !p2Alive) {
          return {
            ...room,
            p2: user.name,
            p2Uid: user.uid,
            p2Id: user.studentId,
            lastActive: now,
            presence: {
              ...(room.presence || {}),
              [user.uid]: { online: true, ts: now },
            },
          };
        }

        return room;
      });
    } catch (err) {
      console.error(err);
      alert('進房失敗，請再試一次');
      return;
    }

    if (!result?.committed) {
      alert('進房交易未成功寫入 Firebase');
      return;
    }

    await dbSet(`rooms/${tid}/presence/${user.uid}`, {
      online: true,
      ts: Date.now(),
    }).catch(console.error);

    await dbUpdate(`rooms/${tid}`, {
      lastActive: Date.now(),
    }).catch(console.error);

    const verifySnap = await get(ref(db, `rooms/${tid}`));
    const finalRoom = verifySnap.val();

    console.log('JOIN VERIFY ROOM =>', tid, finalRoom);

    if (!finalRoom) {
      alert('Firebase 內找不到房間資料');
      return;
    }

    const role =
      finalRoom.p1Uid === user.uid ? 'p1' : finalRoom.p2Uid === user.uid ? 'p2' : null;

    console.log('JOIN ROLE CHECK =>', {
      tid,
      myUid: user.uid,
      p1Uid: finalRoom.p1Uid,
      p2Uid: finalRoom.p2Uid,
      role,
    });

    if (!role) {
      alert('此房間已滿或房間狀態尚未清除，請換桌或稍後再試');
      return;
    }

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

        const roleFromDb =
          data.p1Uid === user.uid ? 'p1' : data.p2Uid === user.uid ? 'p2' : null;

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

        if (data.roomQuestions) {
          setQuestions(data.roomQuestions);
        }

        if (data.gameOver && !gameOverPlayedRef.current) {
          const myFinal = roleFromDb === 'p1' ? data.scores?.p1 || 0 : data.scores?.p2 || 0;
          const oppFinal = roleFromDb === 'p1' ? data.scores?.p2 || 0 : data.scores?.p1 || 0;

          [aiBgm, gameBgm].forEach((b) => b.current.pause());

          if (myFinal > oppFinal) winSfx.current.play().catch(console.error);
          else loseSfx.current.play().catch(console.error);

          gameOverPlayedRef.current = true;
        }

        if (!data.gameOver) {
          gameOverPlayedRef.current = false;
        }
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
            return {
              ...room,
              gameOver: true,
              finishedAt: Date.now(),
              lastActive: Date.now(),
            };
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

      if (advanceTimerRef.current === timerId) {
        advanceTimerRef.current = null;
      }

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

      const roomMyRole =
        room.p1Uid === user.uid ? 'p1' : room.p2Uid === user.uid ? 'p2' : null;
      if (!roomMyRole) return room;

      const roomMyAnswered = roomMyRole === 'p1' ? !!room.selections?.p1 : !!room.selections?.p2;
      const roomOppUid = roomMyRole === 'p1' ? room.p2Uid : room.p1Uid;
      const roomOppAlive = isAliveByUid(room, roomOppUid);

      if (!roomMyAnswered && Date.now() < (room.questionEndsAt || 0)) return room;
      if (roomMyAnswered && roomOppAlive && Date.now() < (room.questionEndsAt || 0)) return room;

      const alreadyBothAnswered = !!room.selections?.p1 && !!room.selections?.p2;
      if (alreadyBothAnswered) return room;

      const nextSelections = { ...(room.selections || {}) };

      if (!nextSelections.p1) {
        nextSelections.p1 = { text: '', isCorrect: false, timedOut: true };
      }
      if (!nextSelections.p2) {
        nextSelections.p2 = { text: '', isCorrect: false, timedOut: true };
      }

      const nextIdx = (room.currentIdx || 0) + 1;

      if (nextIdx >= (room.roomQuestions?.length || QUESTION_COUNT)) {
        return {
          ...room,
          selections: nextSelections,
          gameOver: true,
          finishedAt: Date.now(),
          lastActive: Date.now(),
        };
      }

      return {
        ...room,
        selections: null,
        currentIdx: nextIdx,
        questionEndsAt: Date.now() + QUESTION_TIME * 1000,
        lastActive: Date.now(),
      };
    })
      .catch(console.error)
      .finally(() => {
        isSwitching.current = false;
      });
  }, [
    roomId,
    myRole,
    roomData,
    roomGameOver,
    questionEndsAt,
    bothAnswered,
    p1Answered,
    p2Answered,
    user?.uid,
  ]);

  useEffect(() => {
    if (!isAiMode || !roomId || roomGameOver) return;
    if (!p1Answered || p2Answered) return;

    const expectedIdx = roomCurrentIdx;

    const timer = setTimeout(async () => {
      const q = roomDataRef.current?.roomQuestions?.[expectedIdx];
      if (!q) return;

      const correctOpt = q.options.find((o) => o.isCorrect);
      const wrongOpts = q.options.filter((o) => !o.isCorrect);
      const aiOpt =
        Math.random() < 0.6
          ? correctOpt
          : wrongOpts[Math.floor(Math.random() * wrongOpts.length)] || correctOpt;

      await dbTx(`rooms/${roomId}`, (room) => {
        if (!room || room.gameOver) return room;
        if ((room.currentIdx || 0) !== expectedIdx) return room;
        if (room.selections?.p2) return room;

        const gained = aiOpt?.isCorrect ? 10 : 0;

        return {
          ...room,
          selections: {
            ...(room.selections || {}),
            p2: {
              text: aiOpt?.text || '',
              isCorrect: !!aiOpt?.isCorrect,
            },
          },
          scores: {
            ...(room.scores || { p1: 0, p2: 0 }),
            p2: (room.scores?.p2 || 0) + gained,
          },
          lastActive: Date.now(),
        };
      }).catch(console.error);
    }, 800);

    return () => clearTimeout(timer);
  }, [isAiMode, roomId, roomGameOver, roomCurrentIdx, p1Answered, p2Answered]);

  const onSelect = async (opt) => {
    if (!roomId || !user?.uid) return;
    if (gameOver) return;
    if (!p2Joined && !isAiMode) return;
    if (selections?.[myRole]) return;

    if (opt.isCorrect) {
      correctSfx.current.currentTime = 0;
      correctSfx.current.play().catch(console.error);
    } else {
      wrongSfx.current.currentTime = 0;
      wrongSfx.current.play().catch(console.error);
    }

    const result = await dbTx(`rooms/${roomId}`, (room) => {
      if (!room || room.gameOver) return room;

      const role =
        room.p1Uid === user.uid ? 'p1' : room.p2Uid === user.uid ? 'p2' : null;

      if (!role) return room;
      if (room.selections?.[role]) return room;
      if (Date.now() > (room.questionEndsAt || 0)) return room;

      const left = Math.max(
        0,
        Math.ceil(((room.questionEndsAt || 0) - Date.now()) / 1000)
      );

      const gained = opt.isCorrect
        ? (left >= 13 ? 20 : 10) + Math.floor(left * 0.5)
        : 0;

      return {
        ...room,
        selections: {
          ...(room.selections || {}),
          [role]: {
            text: opt.text,
            isCorrect: !!opt.isCorrect,
          },
        },
        scores: {
          ...(room.scores || { p1: 0, p2: 0 }),
          [role]: (room.scores?.[role] || 0) + gained,
        },
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

    let rewardPoints = 0;
    if (isAiMode) {
      rewardPoints = isWin ? Math.floor(myScore * 0.5) : Math.floor(myScore * 0.3);
    } else {
      rewardPoints = isWin ? myScore : Math.floor(myScore * 0.8);
    }

    const updates = {};
    updates[`users/${user.uid}/totalScore`] = increment(rewardPoints);

    if (!isAiMode) {
      updates[`users/${user.uid}/wins`] = increment(isWin ? 1 : 0);
      updates[`users/${user.uid}/losses`] = increment(isWin ? 0 : 1);
      if (isWin) updates[`users/${user.uid}/hp`] = increment(5);
    }

    await dbRootUpdate(updates).catch(console.error);

    if (roomId) {
      await dbRemove(`rooms/${roomId}`).catch(console.error);
    }

    stopAllAudio();
    resetGameState();
    setView('lobby');
  };

  const sendMessage = async () => {
    if (!user || !inputMsg.trim()) return;

    await dbPush('messages', {
      user: user.name,
      text: inputMsg.trim(),
      timestamp: Date.now(),
    }).catch(console.error);

    setInputMsg('');
  };

  const renderMessageBoard = (compact = false) => (
    <div
      className="box"
      style={{
        marginTop: compact ? '12px' : 0,
      }}
    >
      <h4 style={{ marginTop: 0 }}>💬 留言板 (最新在上方)</h4>
      <div
        className="msg-box"
        style={{
          height: compact ? '220px' : '300px',
        }}
      >
        {messages
          .slice()
          .reverse()
          .map((m, i) => (
            <div
              key={`${m.timestamp || 0}-${i}`}
              style={{
                marginBottom: '8px',
                borderBottom: '1px solid #222',
                paddingBottom: '4px',
                wordBreak: 'break-word',
                lineHeight: 1.6,
              }}
            >
              <span>
                <b style={{ color: '#4caf50' }}>{m.user}</b>: {m.text}
                <span style={{ color: '#888', marginLeft: '8px', fontSize: '0.85em' }}>
                  {formatMessageTime(m.timestamp)}
                </span>
              </span>
            </div>
          ))}
      </div>

      <div style={{ display: 'flex', gap: '5px' }}>
        <input
          value={inputMsg}
          onChange={(e) => setInputMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') sendMessage();
          }}
          style={{
            flex: 1,
            padding: '10px',
            borderRadius: '8px',
            background: '#333',
            border: 'none',
            color: 'white',
            minWidth: 0,
          }}
          placeholder="輸入聊天..."
        />
        <button
          onClick={sendMessage}
          className="btn"
          style={{ background: '#4caf50', color: 'white', flexShrink: 0 }}
        >
          發送
        </button>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div style={{ color: 'white', textAlign: 'center', marginTop: '50px' }}>
        載入中...
      </div>
    );
  }

  return (
    <div className="safe-container">
      <style>{`
        html, body, #root {
          margin: 0;
          padding: 0;
          min-height: 100%;
          background: #121212;
          font-family: sans-serif;
          color: white;
          overflow-x: hidden;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
        }

        .safe-container {
          min-height: 100dvh;
          width: 100%;
          overflow-x: hidden;
          overflow-y: auto;
          box-sizing: border-box;
        }

        .box {
          background: #1e1e1e;
          padding: 20px;
          border-radius: 15px;
          border: 1px solid #333;
          margin-bottom: 10px;
          box-sizing: border-box;
        }

        .btn {
          padding: 12px;
          border-radius: 8px;
          border: none;
          font-weight: bold;
          cursor: pointer;
        }

        .avatar {
          width: 40px;
          height: 40px;
          border-radius: 50%;
          object-fit: cover;
          border: 2px solid #444;
          background: #333;
          flex-shrink: 0;
        }

        .avatar-lg {
          width: 80px;
          height: 80px;
          border-radius: 50%;
          object-fit: cover;
          border: 3px solid #ffeb3b;
          background: #333;
          flex-shrink: 0;
        }

        .rank-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.85rem;
          table-layout: auto;
        }

        .rank-table th {
          text-align: left;
          color: #888;
          border-bottom: 1px solid #444;
          padding: 5px 8px;
          white-space: nowrap;
        }

        .rank-table td {
          padding: 8px 8px;
          border-bottom: 1px solid #222;
          vertical-align: middle;
          white-space: nowrap;
        }

        .lobby-layout {
          display: grid;
          grid-template-columns: 380px 1fr;
          gap: 20px;
          max-width: 1260px;
          margin: 0 auto;
          padding: 10px;
          box-sizing: border-box;
        }

        header {
          position: sticky;
          top: 0;
          z-index: 1000;
          background: #1e1e1e;
          padding: 10px 15px;
          border-bottom: 2px solid #333;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          box-sizing: border-box;
        }

        .msg-box {
          height: 300px;
          overflow-y: auto;
          background: #111;
          padding: 15px;
          border-radius: 10px;
          margin-bottom: 10px;
          border: 1px solid #333;
          display: flex;
          flex-direction: column;
          box-sizing: border-box;
        }

        .option-btn {
          padding: 18px;
          font-size: 1.1rem;
          border-radius: 12px;
          border: none;
          color: white;
          background: #333;
          margin-bottom: 10px;
          width: 100%;
          text-align: left;
          cursor: pointer;
          box-sizing: border-box;
          word-break: break-word;
        }

        input, button, textarea, select {
          font-size: 16px;
        }

        @media (max-width: 980px) {
          .lobby-layout {
            grid-template-columns: 1fr;
            gap: 12px;
            padding: 8px;
          }
        }

        @media (max-width: 850px) {
          .box {
            padding: 14px;
            border-radius: 12px;
          }

          .avatar-lg {
            width: 64px;
            height: 64px;
          }

          .rank-table {
            font-size: 0.78rem;
          }

          .option-btn {
            padding: 14px;
            font-size: 1rem;
          }
        }

        @media (max-width: 480px) {
          header {
            padding: 10px;
          }

          .box {
            padding: 12px;
          }

          .msg-box {
            height: 220px;
            padding: 10px;
          }

          .avatar {
            width: 34px;
            height: 34px;
          }

          .avatar-lg {
            width: 56px;
            height: 56px;
          }

          .rank-table {
            font-size: 0.72rem;
          }

          .option-btn {
            padding: 12px;
            font-size: 0.95rem;
          }
        }
      `}</style>

      {view === 'login' && (
        <div
          style={{
            padding: '40px 12px',
            textAlign: 'center',
            width: '100%',
            boxSizing: 'border-box',
            overflowX: 'hidden',
          }}
        >
          <h1>⚔️ 知識對戰系統</h1>
          <div
            className="box"
            style={{
              maxWidth: '360px',
              width: '100%',
              margin: '0 auto',
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                background: '#111',
                border: '1px solid #333',
                borderRadius: '10px',
                padding: '12px 14px',
                marginBottom: '18px',
                lineHeight: 1.8,
                color: '#ffeb3b',
                fontWeight: 'bold',
              }}
            >
              <div>登入請輸入「學號」</div>
              <div>密碼都是「111111」</div>
            </div>

            <input
              placeholder="學號"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              style={{
                width: '100%',
                padding: '12px',
                marginBottom: '15px',
                background: '#111',
                color: 'white',
                border: '1px solid #444',
                borderRadius: '8px',
                boxSizing: 'border-box',
              }}
            />
            <input
              type="password"
              placeholder="密碼"
              value={loginPwd}
              onChange={(e) => setLoginPwd(e.target.value)}
              style={{
                width: '100%',
                padding: '12px',
                marginBottom: '25px',
                background: '#111',
                color: 'white',
                border: '1px solid #444',
                borderRadius: '8px',
                boxSizing: 'border-box',
              }}
            />
            <button
              className="btn"
              onClick={handleLogin}
              style={{ width: '100%', background: '#4caf50', color: 'white' }}
            >
              登入
            </button>
          </div>
        </div>
      )}

      {user && view !== 'login' && (
        <>
          <header>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              <img
                src={avatarSrc(user.studentId)}
                className="avatar"
                alt=""
                onError={(e) => {
                  e.target.src = 'https://via.placeholder.com/40';
                }}
              />
              <b style={{ wordBreak: 'break-word' }}>{user.name}</b>
              <span style={{ color: '#ff5252', marginLeft: '5px' }}>❤️ {user.hp}</span>
              <span style={{ color: '#ffeb3b', marginLeft: '5px' }}>💰 {user.totalScore}</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {!user?.isTeacher && (
                <button
                  onClick={async () => {
                    if (user.totalScore < 15) {
                      alert('積分不足');
                      return;
                    }
                    await dbUpdate(`users/${user.uid}`, {
                      totalScore: increment(-15),
                      hp: increment(1),
                    }).catch(console.error);
                    alert('兌換成功');
                  }}
                  className="btn"
                  style={{
                    background: '#4caf50',
                    color: 'white',
                    padding: '5px 10px',
                    fontSize: '0.8rem',
                  }}
                >
                  +1HP(15分)
                </button>
              )}
              <button
                onClick={async () => {
                  await signOut(auth).catch(console.error);
                  resetGameState();
                  setUser(null);
                  setView('login');
                }}
                className="btn"
                style={{
                  background: '#555',
                  color: 'white',
                  padding: '5px 10px',
                  fontSize: '0.8rem',
                }}
              >
                登出
              </button>
            </div>
          </header>

          <main style={{ width: '100%', boxSizing: 'border-box', paddingTop: '12px' }}>
            {view === 'lobby' && user?.isTeacher && (
              <div
                style={{
                  maxWidth: '1200px',
                  width: '100%',
                  margin: '0 auto',
                  padding: '8px',
                  boxSizing: 'border-box',
                }}
              >
                <div className="box">
                  <h3 style={{ color: '#ffeb3b', textAlign: 'center', marginTop: 0 }}>
                    📊 學生容易錯的題目
                  </h3>

                  {questionStatsList.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#aaa', padding: '20px 0' }}>
                      目前尚無統計資料
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="rank-table" style={{ fontSize: '0.95rem', minWidth: '820px' }}>
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>題目</th>
                            <th>正解</th>
                            <th>作答次數</th>
                            <th>答錯次數</th>
                            <th>錯誤率</th>
                          </tr>
                        </thead>
                        <tbody>
                          {questionStatsList.map((q, i) => (
                            <tr key={q.id}>
                              <td>{i + 1}</td>
                              <td style={{ maxWidth: '520px', whiteSpace: 'normal', lineHeight: 1.6 }}>
                                {q.question}
                              </td>
                              <td style={{ color: '#4caf50', whiteSpace: 'normal' }}>{q.correctAnswer || '-'}</td>
                              <td>{q.attempts}</td>
                              <td style={{ color: '#ff5252' }}>{q.wrongs}</td>
                              <td style={{ color: '#ffeb3b' }}>
                                {q.attempts > 0 ? `${(q.wrongRate * 100).toFixed(1)}%` : '0%'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {renderMessageBoard()}
              </div>
            )}

            {view === 'lobby' && !user?.isTeacher && (
              <div className="lobby-layout">
                <div className="box">
                  <h3 style={{ color: '#ffeb3b', textAlign: 'center', marginTop: 0 }}>🏆 榮譽榜</h3>
                  <div style={{ overflowX: 'auto', width: '100%' }}>
                    <table className="rank-table" style={{ minWidth: '560px' }}>
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>頭像</th>
                          <th>姓名</th>
                          <th>積分</th>
                          <th>勝</th>
                          <th>敗</th>
                          <th>勝率</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaderboard.map((u, i) => (
                          <tr key={u.uid}>
                            <td>{i + 1}</td>
                            <td>
                              <img
                                src={avatarSrc(u.studentId)}
                                className="avatar"
                                alt=""
                                onError={(e) => {
                                  e.target.src = 'https://via.placeholder.com/40';
                                }}
                              />
                            </td>
                            <td>{u.name}</td>
                            <td style={{ color: '#4caf50' }}>{u.totalScore}</td>
                            <td>{u.wins || 0}</td>
                            <td>{u.losses || 0}</td>
                            <td style={{ color: '#ffeb3b' }}>{calcWinRate(u.wins, u.losses)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div>
                  <div className="box" style={{ textAlign: 'center', border: '1px solid #ff5252' }}>
                    <button
                      className="btn"
                      onClick={startAiGame}
                      style={{ background: '#ff5252', color: 'white', width: '100%' }}
                    >
                      🤖 AI 練習對戰 (4 HP)
                    </button>
                  </div>

                  <div className="box">
                    <h4 style={{ textAlign: 'center', marginTop: 0 }}>🎮 真人對戰桌 (2 HP) build-0320-B</h4>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
                        gap: '8px',
                      }}
                    >
                      {Array.from({ length: TOTAL_TABLES }).map((_, i) => {
                        const tid = `Table_${i + 1}`;
                        const status = roomStatusMap[tid] || {
                          count: 0,
                          label: '空房',
                          people: '0/2人',
                          bg: '#2c2c2c',
                          border: '#444',
                          shadow: 'transparent',
                        };

                        return (
                          <button
                            key={i}
                            className="btn"
                            onClick={() => handleJoinTable(i + 1)}
                            style={{
                              background: status.bg,
                              color: 'white',
                              border: `1px solid ${status.border}`,
                              boxShadow: `0 0 0 1px ${status.border} inset, 0 0 12px ${status.shadow || 'transparent'}`,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '4px',
                              minHeight: '64px',
                            }}
                          >
                            <span>桌 {i + 1}</span>
                            <span style={{ fontSize: '0.75rem', color: '#ddd' }}>{status.label}</span>
                            <span style={{ fontSize: '0.7rem', color: '#bbb' }}>{status.people}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div
                      style={{
                        marginTop: '12px',
                        fontSize: '12px',
                        color: '#aaa',
                        background: '#111',
                        border: '1px solid #333',
                        borderRadius: '8px',
                        padding: '8px',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all',
                      }}
                    >
                      DEBUG Table_1:
                      {'\n'}
                      {JSON.stringify(debugTable1, null, 2)}
                    </div>
                  </div>

                  {renderMessageBoard()}
                </div>
              </div>
            )}

            {view === 'game' && (
              <div
                style={{
                  maxWidth: '800px',
                  width: '100%',
                  margin: '0 auto',
                  padding: '8px',
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                  <div style={{ fontSize: '3rem', fontWeight: 'bold' }}>{timeLeft}s</div>
                  <div
                    style={{
                      textAlign: 'center',
                      color: '#888',
                      fontSize: '0.85rem',
                      marginBottom: '8px',
                    }}
                  >
                    build-0320-B | roomId: {roomId || '-'}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-around',
                      alignItems: 'center',
                      gap: '12px',
                      flexWrap: 'wrap',
                      background: '#1e1e1e',
                      padding: '15px',
                      borderRadius: '15px',
                      border: '1px solid #444',
                    }}
                  >
                    <div style={{ minWidth: 100 }}>
                      <img
                        src={avatarSrc(p1Id, 80)}
                        className="avatar-lg"
                        alt=""
                        onError={(e) => {
                          e.target.src = 'https://via.placeholder.com/80';
                        }}
                      />
                      <div style={{ fontSize: '1.5rem', color: '#4caf50' }}>{p1Score}</div>
                      <small style={{ wordBreak: 'break-word' }}>{p1Name}</small>
                    </div>
                    <div style={{ fontSize: '2rem' }}>VS</div>
                    <div style={{ minWidth: 100 }}>
                      <img
                        src={avatarSrc(p2Id, 80)}
                        className="avatar-lg"
                        alt=""
                        onError={(e) => {
                          e.target.src = 'https://via.placeholder.com/80';
                        }}
                      />
                      <div style={{ fontSize: '1.5rem', color: '#2196f3' }}>{p2Score}</div>
                      <small style={{ wordBreak: 'break-word' }}>{p2Name}</small>
                    </div>
                  </div>
                </div>

                {(p2Joined || isAiMode) ? (
                  questions[currentIdx] && (
                    <div className="box">
                      <div style={{ fontSize: '1.2rem', marginBottom: '15px', wordBreak: 'break-word' }}>
                        Q{currentIdx + 1}: {questions[currentIdx].question}
                      </div>
                      {questions[currentIdx].options.map((opt, i) => (
                        <button
                          key={i}
                          onClick={() => onSelect(opt)}
                          disabled={!!selections?.[myRole] || gameOver}
                          className="option-btn"
                          style={{
                            background: selections?.[myRole]
                              ? opt.isCorrect
                                ? '#2e7d32'
                                : selections[myRole].text === opt.text
                                  ? '#c62828'
                                  : '#333'
                              : '#333',
                          }}
                        >
                          {opt.text}
                        </button>
                      ))}
                    </div>
                  )
                ) : (
                  <div className="box" style={{ textAlign: 'center', padding: '32px 12px' }}>
                    ⏳ 等待對手加入...
                  </div>
                )}

                {renderMessageBoard(true)}
              </div>
            )}
          </main>

          {gameOver && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.95)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                zIndex: 2000,
                padding: '20px',
                boxSizing: 'border-box',
                textAlign: 'center',
              }}
            >
              <h1
                style={{
                  fontSize: 'clamp(2.2rem, 10vw, 4rem)',
                  color:
                    (myRole === 'p1' ? p1Score : p2Score) >
                    (myRole === 'p1' ? p2Score : p1Score)
                      ? '#ffeb3b'
                      : '#ff5252',
                  marginBottom: '20px',
                }}
              >
                {(myRole === 'p1' ? p1Score : p2Score) >
                (myRole === 'p1' ? p2Score : p1Score)
                  ? 'VICTORY! 🎉'
                  : 'DEFEAT... 💀'}
              </h1>
              <button
                className="btn"
                onClick={finishGameAndGoLobby}
                style={{
                  background: '#4caf50',
                  color: 'white',
                  padding: '15px 32px',
                  fontSize: '1.1rem',
                  maxWidth: '100%',
                }}
              >
                返回大廳
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;