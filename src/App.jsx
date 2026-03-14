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

function App() {
  const [user, setUser] = useState(null);
  const [loginId, setLoginId] = useState('');
  const [loginPwd, setLoginPwd] = useState('');
  const [view, setView] = useState('login');
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [inputMsg, setInputMsg] = useState('');

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
      return `${BASE}avatars/${String(studentId).trim()}.jpg`;
    },
    [BASE]
  );

  const calcWinRate = (w = 0, l = 0) => {
    const total = (w || 0) + (l || 0);
    return total === 0 ? '0%' : ((w / total) * 100).toFixed(1) + '%';
  };

  const shuffleQuestions = useCallback((source) => {
    const arr = [...source];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, QUESTION_COUNT);
  }, []);

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
  }, [stopAllAudio]);

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
      lobbyBgm.current.play().catch((err) => console.error(err));
    } else if (view === 'game') {
      if (isAiMode) aiBgm.current.play().catch((err) => console.error(err));
      else gameBgm.current.play().catch((err) => console.error(err));
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
        await set(userRef, baseUserData);
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
      (err) => console.error(err)
    );

    const offMessages = onValue(
      ref(db, 'messages'),
      (snap) => {
        const val = snap.val() || {};
        const list = Object.values(val).sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        setMessages(list);
      },
      (err) => console.error(err)
    );

    return () => {
      offUsers();
      offMessages();
    };
  }, [user?.uid]);

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
        await set(userRef, baseUserData);
      } else {
        finalUserData = {
          ...baseUserData,
          ...snap.val(),
        };

        await update(userRef, {
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

    await set(ref(db, `rooms/${tid}`), {
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
    }).catch((err) => console.error(err));

    await update(ref(db, `users/${user.uid}`), { hp: increment(-4) }).catch((err) =>
      console.error(err)
    );

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
    const roomRef = ref(db, `rooms/${tid}`);
    const shuffled = shuffleQuestions(allQuestions);
    const now = Date.now();

    let result;
    try {
      result = await runTransaction(roomRef, (room) => {
        const inactive =
          !room ||
          room.gameOver ||
          !room.p1Uid ||
          now - (room.lastActive || 0) > ROOM_TIMEOUT_MS;

        if (inactive) {
          return {
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
            rewardClaimed: {},
            presence: {},
          };
        }

        if (room.p1Uid === user.uid || room.p2Uid === user.uid) {
          return {
            ...room,
            lastActive: now,
          };
        }

        if (!room.p2Uid) {
          return {
            ...room,
            p2: user.name,
            p2Uid: user.uid,
            p2Id: user.studentId,
            lastActive: now,
          };
        }

        return room;
      });
    } catch (err) {
      console.error(err);
      alert('進房失敗，請再試一次');
      return;
    }

    const finalRoom = result.snapshot.val();
    if (!finalRoom) {
      alert('進房失敗，請再試一次');
      return;
    }

    const role =
      finalRoom.p1Uid === user.uid ? 'p1' : finalRoom.p2Uid === user.uid ? 'p2' : null;

    if (!role) {
      alert('此房間已滿');
      return;
    }

    await update(ref(db, `users/${user.uid}`), { hp: increment(-2) }).catch((err) =>
      console.error(err)
    );

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

          if (myFinal > oppFinal) winSfx.current.play().catch((err) => console.error(err));
          else loseSfx.current.play().catch((err) => console.error(err));

          gameOverPlayedRef.current = true;
        }

        if (!data.gameOver) {
          gameOverPlayedRef.current = false;
        }
      },
      (err) => console.error(err)
    );

    return () => offRoom();
  }, [roomId, user?.uid, view, resetGameState, stopAllAudio]);

  useEffect(() => {
    if (!roomId || !user?.uid || view !== 'game') return;

    const roomRef = ref(db, `rooms/${roomId}`);
    const presenceRef = ref(db, `rooms/${roomId}/presence/${user.uid}`);
    const disconnectOp = onDisconnect(presenceRef);

    set(presenceRef, { online: true, ts: Date.now() }).catch((err) => console.error(err));
    disconnectOp.remove().catch((err) => console.error(err));

    const timer = setInterval(() => {
      set(presenceRef, { online: true, ts: Date.now() }).catch((err) => console.error(err));
      update(roomRef, { lastActive: Date.now() }).catch((err) => console.error(err));
    }, HEARTBEAT_MS);

    return () => {
      clearInterval(timer);
      disconnectOp.cancel().catch((err) => console.error(err));
      remove(presenceRef).catch((err) => console.error(err));
    };
  }, [roomId, user?.uid, view]);

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

  useEffect(() => {
    if (!roomId || myRole !== 'p1' || !roomData || roomData.gameOver) return;

    const bothAnswered = !!roomData.selections?.p1 && !!roomData.selections?.p2;
    if (!bothAnswered || isSwitching.current) return;

    isSwitching.current = true;
    const expectedIdx = roomData.currentIdx || 0;

    const timer = setTimeout(async () => {
      await runTransaction(ref(db, `rooms/${roomId}`), (room) => {
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
      }).catch((err) => console.error(err));

      isSwitching.current = false;
    }, REVEAL_MS);

    return () => clearTimeout(timer);
  }, [roomId, myRole, roomData]);

  useEffect(() => {
    if (!roomId || myRole !== 'p1' || !roomData || roomData.gameOver) return;
    if (isSwitching.current) return;
    if (!questionEndsAt) return;
    if (Date.now() < questionEndsAt) return;

    isSwitching.current = true;

    runTransaction(ref(db, `rooms/${roomId}`), (room) => {
      if (!room || room.gameOver) return room;
      if (Date.now() < (room.questionEndsAt || 0)) return room;

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
      .catch((err) => console.error(err))
      .finally(() => {
        isSwitching.current = false;
      });
  }, [roomId, myRole, roomData, questionEndsAt]);

  useEffect(() => {
    if (!isAiMode || !roomId || !roomData || roomData.gameOver) return;
    if (!roomData.selections?.p1 || roomData.selections?.p2) return;

    const expectedIdx = roomData.currentIdx || 0;

    const timer = setTimeout(async () => {
      const q = roomDataRef.current?.roomQuestions?.[expectedIdx];
      if (!q) return;

      const correctOpt = q.options.find((o) => o.isCorrect);
      const wrongOpts = q.options.filter((o) => !o.isCorrect);
      const aiOpt =
        Math.random() < 0.6
          ? correctOpt
          : wrongOpts[Math.floor(Math.random() * wrongOpts.length)] || correctOpt;

      await runTransaction(ref(db, `rooms/${roomId}`), (room) => {
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
      }).catch((err) => console.error(err));
    }, 800);

    return () => clearTimeout(timer);
  }, [isAiMode, roomId, roomData]);

  const onSelect = async (opt) => {
    if (!roomId || !user?.uid) return;
    if (gameOver) return;
    if (!p2Joined && !isAiMode) return;
    if (selections?.[myRole]) return;

    if (opt.isCorrect) {
      correctSfx.current.currentTime = 0;
      correctSfx.current.play().catch((err) => console.error(err));
    } else {
      wrongSfx.current.currentTime = 0;
      wrongSfx.current.play().catch((err) => console.error(err));
    }

    await runTransaction(ref(db, `rooms/${roomId}`), (room) => {
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
    }).catch((err) => console.error(err));
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

    await update(ref(db), updates).catch((err) => console.error(err));

    if (roomId) {
      remove(ref(db, `rooms/${roomId}/presence/${user.uid}`)).catch((err) =>
        console.error(err)
      );
      if (isAiMode) {
        remove(ref(db, `rooms/${roomId}`)).catch((err) => console.error(err));
      }
    }

    stopAllAudio();
    resetGameState();
    setView('lobby');
  };

  const sendMessage = async () => {
    if (!user || !inputMsg.trim()) return;

    await push(ref(db, 'messages'), {
      user: user.name,
      text: inputMsg.trim(),
      timestamp: Date.now(),
    }).catch((err) => console.error(err));

    setInputMsg('');
  };

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
        html, body { background: #121212; margin: 0; padding: 0; font-family: sans-serif; color: white; }
        .box { background: #1e1e1e; padding: 20px; border-radius: 15px; border: 1px solid #333; margin-bottom: 10px; }
        .btn { padding: 12px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; }
        .avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid #444; background: #333; }
        .avatar-lg { width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 3px solid #ffeb3b; background: #333; }
        .rank-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .rank-table th { text-align: left; color: #888; border-bottom: 1px solid #444; padding: 5px; }
        .rank-table td { padding: 8px 5px; border-bottom: 1px solid #222; }
        .lobby-layout { display: grid; grid-template-columns: 320px 1fr; gap: 20px; max-width: 1200px; margin: 0 auto; padding: 10px; }
        @media (max-width: 850px) { .lobby-layout { grid-template-columns: 1fr; } }
        header { position: sticky; top: 0; z-index: 1000; background: #1e1e1e; padding: 10px 15px; border-bottom: 2px solid #333; display: flex; justify-content: space-between; align-items: center; }
        .msg-box { height: 300px; overflow-y: auto; background: #111; padding: 15px; border-radius: 10px; margin-bottom: 10px; border: 1px solid #333; display: flex; flex-direction: column; }
        .option-btn { padding: 18px; font-size: 1.1rem; border-radius: 12px; border: none; color: white; background: #333; margin-bottom: 10px; width: 100%; text-align: left; cursor: pointer; }
      `}</style>

      {view === 'login' && (
        <div style={{ padding: '80px 20px', textAlign: 'center' }}>
          <h1>⚔️ 知識對戰系統</h1>
          <div className="box" style={{ maxWidth: '360px', margin: '0 auto' }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <img
                src={avatarSrc(user.studentId)}
                className="avatar"
                alt=""
                onError={(e) => (e.target.src = 'https://via.placeholder.com/40')}
              />
              <b>{user.name}</b>
              <span style={{ color: '#ff5252', marginLeft: '5px' }}>❤️ {user.hp}</span>
              <span style={{ color: '#ffeb3b', marginLeft: '5px' }}>💰 {user.totalScore}</span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={async () => {
                  if (user.totalScore < 15) {
                    alert('積分不足');
                    return;
                  }
                  await update(ref(db, `users/${user.uid}`), {
                    totalScore: increment(-15),
                    hp: increment(1),
                  }).catch((err) => console.error(err));
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
              <button
                onClick={async () => {
                  await signOut(auth).catch((err) => console.error(err));
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

          <main style={{ flex: 1, paddingTop: '20px' }}>
            {view === 'lobby' && (
              <div className="lobby-layout">
                <div className="box">
                  <h3 style={{ color: '#ffeb3b', textAlign: 'center', marginTop: 0 }}>🏆 榮譽榜</h3>
                  <table className="rank-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>頭像</th>
                        <th>姓名</th>
                        <th>積分</th>
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
                              onError={(e) => (e.target.src = 'https://via.placeholder.com/40')}
                            />
                          </td>
                          <td>{u.name}</td>
                          <td style={{ color: '#4caf50' }}>{u.totalScore}</td>
                          <td style={{ color: '#ffeb3b' }}>{calcWinRate(u.wins, u.losses)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
                    <h4 style={{ textAlign: 'center', marginTop: 0 }}>🎮 真人對戰桌 (2 HP)</h4>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
                        gap: '8px',
                      }}
                    >
                      {Array.from({ length: 14 }).map((_, i) => (
                        <button
                          key={i}
                          className="btn"
                          onClick={() => handleJoinTable(i + 1)}
                          style={{
                            background: '#2c2c2c',
                            color: 'white',
                            border: '1px solid #444',
                          }}
                        >
                          桌 {i + 1}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="box">
                    <h4 style={{ marginTop: 0 }}>💬 留言板 (最新在上方)</h4>
                    <div className="msg-box">
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
                            }}
                          >
                            <b style={{ color: '#4caf50' }}>{m.user}</b>: {m.text}
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
                        }}
                        placeholder="輸入聊天..."
                      />
                      <button
                        onClick={sendMessage}
                        className="btn"
                        style={{ background: '#4caf50', color: 'white' }}
                      >
                        發送
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {view === 'game' && (
              <div style={{ maxWidth: '800px', margin: '0 auto', padding: '10px' }}>
                <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                  <div style={{ fontSize: '3rem', fontWeight: 'bold' }}>{timeLeft}s</div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-around',
                      alignItems: 'center',
                      background: '#1e1e1e',
                      padding: '15px',
                      borderRadius: '15px',
                      border: '1px solid #444',
                    }}
                  >
                    <div>
                      <img
                        src={p1Id === 'ai' ? 'https://via.placeholder.com/80?text=AI' : avatarSrc(p1Id, 80)}
                        className="avatar-lg"
                        alt=""
                        onError={(e) => (e.target.src = 'https://via.placeholder.com/80')}
                      />
                      <div style={{ fontSize: '1.5rem', color: '#4caf50' }}>{p1Score}</div>
                      <small>{p1Name}</small>
                    </div>
                    <div style={{ fontSize: '2rem' }}>VS</div>
                    <div>
                      <img
                        src={p2Id === 'ai' ? 'https://via.placeholder.com/80?text=AI' : avatarSrc(p2Id, 80)}
                        className="avatar-lg"
                        alt=""
                        onError={(e) => (e.target.src = 'https://via.placeholder.com/80')}
                      />
                      <div style={{ fontSize: '1.5rem', color: '#2196f3' }}>{p2Score}</div>
                      <small>{p2Name}</small>
                    </div>
                  </div>
                </div>

                {(p2Joined || isAiMode) ? (
                  questions[currentIdx] && (
                    <div className="box">
                      <div style={{ fontSize: '1.2rem', marginBottom: '15px' }}>
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
                  <div style={{ textAlign: 'center', padding: '50px' }}>⏳ 等待對手加入...</div>
                )}
              </div>
            )}
          </main>

          {gameOver && (
            <div
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                background: 'rgba(0,0,0,0.95)',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                zIndex: 2000,
              }}
            >
              <h1
                style={{
                  fontSize: '4rem',
                  color:
                    (myRole === 'p1' ? p1Score : p2Score) >
                    (myRole === 'p1' ? p2Score : p1Score)
                      ? '#ffeb3b'
                      : '#ff5252',
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
                  padding: '15px 50px',
                  fontSize: '1.2rem',
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