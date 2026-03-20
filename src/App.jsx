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
  <circle cx="80" cy="80" r="70" fill="#2d2d2d"/>
  <path d="M40 60 Q80 40 120 60" fill="none" stroke="#00d4ff" stroke-width="4"/>
  <circle cx="55" cy="85" r="8" fill="#00d4ff">
    <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite" />
  </circle>
  <circle cx="105" cy="85" r="8" fill="#00d4ff">
    <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite" />
  </circle>
  <rect x="60" y="110" width="40" height="4" fill="#00d4ff" rx="2"/>
  <path d="M75 110 L85 110 L80 100 Z" fill="#00d4ff" />
</svg>
`)}`;

const App = () => {
  // --- 狀態定義 ---
  const [user, setUser] = useState(null);
  const [userData, setUserData] = useState(null);
  const [userIdInput, setUserIdInput] = useState('');
  const [allQuestions, setAllQuestions] = useState([]);
  const [roomsData, setRoomsData] = useState({});
  const [topUsers, setTopUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [stats, setStats] = useState({});

  const [currentRoomId, setCurrentRoomId] = useState(null);
  const [myRole, setMyRole] = useState(null); // 'p1' or 'p2'
  const [gameState, setGameState] = useState('LOBBY'); // LOBBY, WAITING, PLAYING, FINISHED
  const [isAiMode, setIsAiMode] = useState(false);

  const [currentQuestions, setCurrentQuestions] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [timer, setTimer] = useState(QUESTION_TIME);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [reveal, setReveal] = useState(false);
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);
  const [p1Choice, setP1Choice] = useState(null);
  const [p2Choice, setP2Choice] = useState(null);
  const [p1Info, setP1Info] = useState(null);
  const [p2Info, setP2Info] = useState(null);

  const bgMusicRef = useRef(null);
  const lobbyMusicRef = useRef(null);
  const timerRef = useRef(null);
  const heartbeatRef = useRef(null);

  // --- 初始化與監聽 ---
  useEffect(() => {
    Papa.parse('quiz.csv', {
      download: true,
      header: true,
      complete: (results) => setAllQuestions(results.data.filter((q) => q.question)),
    });

    onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (u) {
        const uRef = ref(db, `users/${u.uid}`);
        onValue(uRef, (snap) => setUserData(snap.val()));
      } else {
        setUserData(null);
      }
    });

    onValue(ref(db, 'rooms'), (snap) => setRoomsData(snap.val() || {}));
    onValue(ref(db, 'users'), (snap) => {
      const data = snap.val() || {};
      const sorted = Object.entries(data)
        .map(([id, val]) => ({ id, ...val }))
        .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
        .slice(0, 15);
      setTopUsers(sorted);
    });
    onValue(ref(db, 'messages'), (snap) => {
      const data = snap.val() || {};
      setMessages(Object.entries(data).map(([id, val]) => ({ id, ...val })).reverse().slice(0, 50));
    });
    onValue(ref(db, 'stats'), (snap) => setStats(snap.val() || {}));
  }, []);

  // --- 音效控制 ---
  const playSfx = (type) => {
    const sfx = {
      correct: 'https://actions.google.com/sounds/v1/cartoon/clink_and_glass_hit.ogg',
      wrong: 'https://actions.google.com/sounds/v1/cartoon/boing.ogg',
      click: 'https://actions.google.com/sounds/v1/foley/button_click.ogg',
      win: 'https://actions.google.com/sounds/v1/human_voices/applause.ogg',
      lose: 'https://actions.google.com/sounds/v1/horror/creepy_low_crescendo.ogg',
    };
    new Audio(sfx[type]).play().catch(() => {});
  };

  // --- 登入邏輯 ---
  const handleLogin = async () => {
    const student = STUDENTS.find((s) => s.id === userIdInput);
    if (!student) return alert('學號錯誤！');
    try {
      const email = `${userIdInput}@${AUTH_EMAIL_DOMAIN}`;
      const pwd = `${userIdInput}${userIdInput}`;
      const res = await signInWithEmailAndPassword(auth, email, pwd);
      const uRef = ref(db, `users/${res.user.uid}`);
      const snap = await get(uRef);
      if (!snap.exists()) {
        await set(uRef, {
          name: student.name,
          id: student.id,
          totalScore: 0,
          hp: 20,
          win: 0,
          lose: 0,
          draw: 0,
        });
      }
    } catch (e) {
      alert('登入失敗');
    }
  };

  // --- 進房邏輯 (優化版) ---
  const joinRoom = async (tableNum) => {
    if (!userData) return;
    const cost = 2;
    if (userData.hp < cost) return alert('體力不足！(需要2點)');

    const roomRef = ref(db, `rooms/${tableNum}`);
    const snapshot = await get(roomRef);
    const room = snapshot.val();
    const now = Date.now();

    // 判斷 P1 與 P2 是否真正活躍
    const p1Active = room?.p1 && (now - (room.p1Status || 0) < ROOM_TIMEOUT_MS);
    const p2Active = room?.p2 && (now - (room.p2Status || 0) < ROOM_TIMEOUT_MS);

    let role = null;
    if (!p1Active) role = 'p1';
    else if (!p2Active) role = 'p2';
    else return alert('該房間已滿，請選擇其他桌次。');

    const updates = {
      [`${role}`]: user.uid,
      [`${role}Name`]: userData.name,
      [`${role}Status`]: now,
      [`${role}Score`]: 0,
      [`${role}Choice`]: null,
    };

    if (role === 'p1') {
      const selected = [];
      const shuffled = [...allQuestions].sort(() => 0.5 - Math.random());
      for (let i = 0; i < Math.min(QUESTION_COUNT, shuffled.length); i++) {
        selected.push(shuffled[i]);
      }
      updates.questions = selected;
      updates.currentIndex = 0;
      updates.status = 'WAITING';
    }

    await update(roomRef, updates);
    await update(ref(db, `users/${user.uid}`), { hp: increment(-cost) });

    setCurrentRoomId(tableNum);
    setMyRole(role);
    setGameState('WAITING');
    setIsAiMode(false);
    startHeartbeat(tableNum, role);

    // 斷線處理
    onDisconnect(ref(db, `rooms/${tableNum}/${role}`)).remove();
    onDisconnect(ref(db, `rooms/${tableNum}/${role}Status`)).remove();
  };

  // --- AI 練習模式 ---
  const startAiMode = async () => {
    if (userData.hp < 4) return alert('AI模式需要4點體力');
    await update(ref(db, `users/${user.uid}`), { hp: increment(-4) });
    const selected = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, QUESTION_COUNT);
    setCurrentQuestions(selected);
    setMyRole('p1');
    setIsAiMode(true);
    setGameState('PLAYING');
    setP1Score(0);
    setP2Score(0);
    setCurrentIndex(0);
    setTimer(QUESTION_TIME);
  };

  // --- Heartbeat ---
  const startHeartbeat = (rId, role) => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    heartbeatRef.current = setInterval(() => {
      update(ref(db, `rooms/${rId}`), { [`${role}Status`]: Date.now() });
    }, HEARTBEAT_MS);
  };

  // --- 遊戲同步監聽 ---
  useEffect(() => {
    if (!currentRoomId || isAiMode) return;
    const roomRef = ref(db, `rooms/${currentRoomId}`);
    const unsub = onValue(roomRef, (snap) => {
      const data = snap.val();
      if (!data) return;

      if (data.p1 && data.p2 && data.status === 'WAITING' && myRole === 'p1') {
        update(roomRef, { status: 'PLAYING' });
      }

      setGameState(data.status);
      setCurrentQuestions(data.questions || []);
      setCurrentIndex(data.currentIndex || 0);
      setP1Score(data.p1Score || 0);
      setP2Score(data.p2Score || 0);
      setP1Choice(data.p1Choice);
      setP2Choice(data.p2Choice);
      setP1Info({ name: data.p1Name, uid: data.p1 });
      setP2Info({ name: data.p2Name, uid: data.p2 });

      if (data.status === 'PLAYING') {
        if (data.p1Choice !== undefined && data.p2Choice !== undefined && data.p1Choice !== null && data.p2Choice !== null && !reveal) {
          triggerReveal();
        }
      }
    });
    return () => unsub();
  }, [currentRoomId, myRole, isAiMode, reveal]);

  // --- 計時器 ---
  useEffect(() => {
    if (gameState !== 'PLAYING') return;
    setTimer(QUESTION_TIME);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimer((prev) => {
        if (prev <= 1) {
          if (!isAiMode && !reveal) handleTimeUp();
          if (isAiMode && !reveal) triggerRevealAi();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [currentIndex, gameState]);

  const handleTimeUp = async () => {
    if (isAiMode) return;
    const roomRef = ref(db, `rooms/${currentRoomId}`);
    const snap = await get(roomRef);
    const data = snap.val();
    if (myRole === 'p1' && data.p1Choice === null) update(roomRef, { p1Choice: -1 });
    if (myRole === 'p2' && data.p2Choice === null) update(roomRef, { p2Choice: -1 });
  };

  const handleChoice = async (idx) => {
    if (reveal || selectedIdx !== null) return;
    setSelectedIdx(idx);
    playSfx('click');
    if (isAiMode) {
      setP1Choice(idx);
      const aiChoice = Math.random() < 0.6 ? parseInt(currentQuestions[currentIndex].answer) - 1 : Math.floor(Math.random() * 4);
      setP2Choice(aiChoice);
      triggerRevealAi();
    } else {
      update(ref(db, `rooms/${currentRoomId}`), { [`${myRole}Choice`]: idx });
    }
  };

  const triggerReveal = () => {
    setReveal(true);
    setTimeout(async () => {
      if (myRole === 'p1') {
        const roomRef = ref(db, `rooms/${currentRoomId}`);
        const snap = await get(roomRef);
        const data = snap.val();
        const q = data.questions[data.currentIndex];
        const ans = parseInt(q.answer) - 1;

        let newP1 = data.p1Score || 0;
        let newP2 = data.p2Score || 0;

        if (data.p1Choice === ans) newP1 += (timer > 13 ? 3 : timer > 7 ? 2 : 1);
        if (data.p2Choice === ans) newP2 += (timer > 13 ? 3 : timer > 7 ? 2 : 1);

        const isLast = data.currentIndex >= QUESTION_COUNT - 1;
        update(roomRef, {
          p1Score: newP1,
          p2Score: newP2,
          p1Choice: null,
          p2Choice: null,
          currentIndex: isLast ? data.currentIndex : data.currentIndex + 1,
          status: isLast ? 'FINISHED' : 'PLAYING',
        });

        // 統計
        const sRef = ref(db, `stats/${q.id || 'q'}`);
        if (data.p1Choice !== ans) update(sRef, { wrong: increment(1), text: q.question });
        if (data.p2Choice !== ans) update(sRef, { wrong: increment(1), text: q.question });
        update(sRef, { total: increment(2) });
      }
      setReveal(false);
      setSelectedIdx(null);
    }, REVEAL_MS);
  };

  const triggerRevealAi = () => {
    setReveal(true);
    setTimeout(() => {
      const q = currentQuestions[currentIndex];
      const ans = parseInt(q.answer) - 1;
      if (p1Choice === ans) setP1Score((s) => s + (timer > 13 ? 3 : timer > 7 ? 2 : 1));
      if (p2Choice === ans) setP2Score((s) => s + (timer > 13 ? 3 : timer > 7 ? 2 : 1));

      if (currentIndex >= QUESTION_COUNT - 1) {
        setGameState('FINISHED');
      } else {
        setCurrentIndex((i) => i + 1);
        setP1Choice(null);
        setP2Choice(null);
        setSelectedIdx(null);
      }
      setReveal(false);
    }, REVEAL_MS);
  };

  const finishGameAndGoLobby = async () => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    const myScore = myRole === 'p1' ? p1Score : p2Score;
    const oppScore = myRole === 'p1' ? p2Score : p1Score;

    let winBonus = 0;
    let resultKey = 'draw';
    if (myScore > oppScore) {
      winBonus = 5;
      resultKey = 'win';
      playSfx('win');
    } else if (myScore < oppScore) {
      resultKey = 'lose';
      playSfx('lose');
    }

    await update(ref(db, `users/${user.uid}`), {
      totalScore: increment(myScore),
      hp: increment(winBonus),
      [resultKey]: increment(1),
    });

    if (!isAiMode) {
      const rRef = ref(db, `rooms/${currentRoomId}`);
      await update(rRef, { [myRole]: null, [`${myRole}Name`]: null });
      const snap = await get(rRef);
      if (!snap.val().p1 && !snap.val().p2) remove(rRef);
    }

    setCurrentRoomId(null);
    setMyRole(null);
    setGameState('LOBBY');
  };

  const sendChat = () => {
    if (!chatInput.trim()) return;
    push(ref(db, 'messages'), {
      name: userData.name,
      text: chatInput,
      ts: Date.now(),
    });
    setChatInput('');
  };

  // --- Render 邏輯 ---
  if (!user) {
    return (
      <div style={styles.container}>
        <div style={styles.loginCard}>
          <h1 style={{ color: '#00d4ff' }}>SSHE Quiz PvP</h1>
          <input
            className="input"
            placeholder="輸入學號 (如 112001)"
            value={userIdInput}
            onChange={(e) => setUserIdInput(e.target.value)}
          />
          <button className="btn" onClick={handleLogin} style={{ background: '#00d4ff', color: '#000' }}>
            進入大廳
          </button>
        </div>
      </div>
    );
  }

  const renderLobby = () => (
    <div style={styles.lobbyContainer}>
      <header style={styles.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
          <div style={styles.avatar}>{userData?.name?.[0]}</div>
          <div>
            <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{userData?.name}</div>
            <div style={{ color: '#aaa', fontSize: '0.9rem' }}>積分: {userData?.totalScore} | HP: {userData?.hp}</div>
          </div>
        </div>
        <button className="btn" onClick={() => signOut(auth)} style={{ background: '#ff5252', width: 'auto', padding: '8px 15px' }}>
          登出
        </button>
      </header>

      <div style={styles.lobbyGrid}>
        <div style={styles.mainArea}>
          <div style={styles.sectionTitle}>戰鬥桌次</div>
          <div style={styles.tableGrid}>
            {Array.from({ length: TOTAL_TABLES }, (_, i) => i + 1).map((tNum) => {
              const r = roomsData[tNum];
              const now = Date.now();
              // 判定 P1, P2 是否活躍
              const p1Active = r?.p1 && (now - (r.p1Status || 0) < ROOM_TIMEOUT_MS);
              const p2Active = r?.p2 && (now - (r.p2Status || 0) < ROOM_TIMEOUT_MS);
              const count = (p1Active ? 1 : 0) + (p2Active ? 1 : 0);

              // 顏色邏輯
              let bgColor = '#4caf50'; // 0人: 綠色
              if (count === 1) bgColor = '#ff9800'; // 1人: 橘色
              if (count === 2) bgColor = '#f44336'; // 2人: 紅色

              return (
                <button
                  key={tNum}
                  className="btn"
                  onClick={() => joinRoom(tNum)}
                  disabled={count >= 2}
                  style={{
                    background: bgColor,
                    margin: '5px',
                    width: '90px',
                    height: '70px',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    alignItems: 'center',
                    opacity: count >= 2 ? 0.6 : 1,
                    cursor: count >= 2 ? 'not-allowed' : 'pointer',
                    border: 'none',
                    borderRadius: '12px',
                    boxShadow: '0 4px 10px rgba(0,0,0,0.3)',
                    transition: 'transform 0.2s',
                  }}
                >
                  <span style={{ fontWeight: 'bold', fontSize: '1.1rem' }}>{tNum}號桌</span>
                  <span style={{ fontSize: '0.8rem' }}>{count}/2 人</span>
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: '20px' }}>
            <button className="btn" onClick={startAiMode} style={{ background: 'linear-gradient(45deg, #00d4ff, #0055ff)' }}>
              🤖 啟動 AI 練習模式 (消耗 4 HP)
            </button>
          </div>

          <div style={{ marginTop: '30px' }}>
            <div style={styles.sectionTitle}>即時留言板</div>
            <div style={styles.chatBox}>
              <div style={styles.chatMsgs}>
                {messages.map((m) => (
                  <div key={m.id} style={{ marginBottom: '8px' }}>
                    <span style={{ color: '#00d4ff', fontWeight: 'bold' }}>{m.name}: </span>
                    <span>{m.text}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '10px' }}>
                <input
                  className="input"
                  style={{ margin: 0 }}
                  value={chatInput}
                  placeholder="說點什麼..."
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendChat()}
                />
                <button className="btn" onClick={sendChat} style={{ width: '80px', background: '#333' }}>傳送</button>
              </div>
            </div>
          </div>
        </div>

        <aside style={styles.sideArea}>
          <div style={styles.sectionTitle}>🏆 英雄榜</div>
          <div style={styles.rankList}>
            {topUsers.map((u, i) => (
              <div key={u.id} style={styles.rankItem}>
                <span>{i + 1}. {u.name}</span>
                <span style={{ color: '#ffeb3b' }}>{u.totalScore}</span>
              </div>
            ))}
          </div>

          <div style={{ ...styles.sectionTitle, marginTop: '20px' }}>📉 易錯題統計</div>
          <div style={styles.rankList}>
            {Object.entries(stats)
              .sort((a, b) => b[1].wrong - a[1].wrong)
              .slice(0, 10)
              .map(([id, val]) => (
                <div key={id} style={{ ...styles.rankItem, fontSize: '0.85rem' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                    {val.text}
                  </span>
                  <span style={{ color: '#ff5252' }}>{Math.round((val.wrong / val.total) * 100)}%</span>
                </div>
              ))}
          </div>
        </aside>
      </div>
    </div>
  );

  const renderGame = () => {
    const q = currentQuestions[currentIndex];
    if (!q) return <div style={styles.container}>載入題目中...</div>;

    const options = [q.option1, q.option2, q.option3, q.option4];
    const ansIdx = parseInt(q.answer) - 1;

    return (
      <div style={styles.gameContainer}>
        {/* 分數面板 */}
        <div style={styles.scoreBoard}>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: '0.9rem', color: '#aaa' }}>{p1Info?.name || 'Player 1'}</div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#00d4ff' }}>{p1Score}</div>
          </div>
          <div style={styles.timerCircle}>{timer}</div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.9rem', color: '#aaa' }}>{isAiMode ? 'AI 機器人' : (p2Info?.name || 'Player 2')}</div>
            <div style={{ fontSize: '2rem', fontWeight: 'bold', color: '#ff5252' }}>{p2Score}</div>
          </div>
        </div>

        {/* 題目區 */}
        <div style={styles.questionCard}>
          <div style={{ fontSize: '1.2rem', color: '#00d4ff', marginBottom: '10px' }}>Question {currentIndex + 1} / {QUESTION_COUNT}</div>
          <h2 style={{ fontSize: '1.5rem', lineHeight: '1.4' }}>{q.question}</h2>
        </div>

        {/* 選項區 */}
        <div style={styles.optionsGrid}>
          {options.map((opt, i) => {
            let border = '2px solid #333';
            let bg = '#1e1e1e';
            if (reveal) {
              if (i === ansIdx) bg = '#2e7d32';
              if (p1Choice === i && i !== ansIdx) bg = '#c62828';
              if (p2Choice === i && i !== ansIdx) border = '3px solid #ff5252';
              if (i === ansIdx) border = '3px solid #4caf50';
            } else if (selectedIdx === i) {
              border = '3px solid #00d4ff';
            }

            return (
              <button key={i} className="option-btn" onClick={() => handleChoice(i)} style={{ ...styles.optionBtn, background: bg, border }}>
                <span style={styles.optionLetter}>{['A', 'B', 'C', 'D'][i]}</span>
                {opt}
              </button>
            );
          })}
        </div>

        {/* 等待對手提示 */}
        {!isAiMode && !reveal && selectedIdx !== null && (
          <div style={{ marginTop: '20px', color: '#aaa', fontStyle: 'italic' }}>等待對手作答...</div>
        )}
      </div>
    );
  };

  const renderFinished = () => {
    const myS = myRole === 'p1' ? p1Score : p2Score;
    const oppS = myRole === 'p1' ? p2Score : p1Score;
    const isWin = myS > oppS;
    const isDraw = myS === oppS;

    return (
      <div style={styles.overlay}>
        <h1 style={{ fontSize: '4rem', color: isWin ? '#ffeb3b' : isDraw ? '#fff' : '#ff5252' }}>
          {isWin ? 'VICTORY! 🎉' : isDraw ? 'DRAW 🤝' : 'DEFEAT... 💀'}
        </h1>
        <div style={{ fontSize: '2rem', margin: '20px 0' }}>{myS} : {oppS}</div>
        <p style={{ color: '#aaa' }}>{isWin ? '獲得體力獎勵 +5 HP' : '下次再接再厲！'}</p>
        <button className="btn" onClick={finishGameAndGoLobby} style={{ background: '#4caf50', marginTop: '30px', width: '200px' }}>
          回到大廳
        </button>
      </div>
    );
  };

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: 'sans-serif' }}>
      {gameState === 'LOBBY' && renderLobby()}
      {gameState === 'WAITING' && (
        <div style={styles.overlay}>
          <div className="loader"></div>
          <h2>等待對手加入...</h2>
          <p>桌號: {currentRoomId}</p>
          <button className="btn" onClick={finishGameAndGoLobby} style={{ background: '#333', width: '150px' }}>取消等待</button>
        </div>
      )}
      {gameState === 'PLAYING' && renderGame()}
      {gameState === 'FINISHED' && renderFinished()}

      <style>{`
        .btn { border: none; border-radius: 8px; padding: 12px; font-size: 1rem; cursor: pointer; color: white; width: 100%; transition: 0.3s; font-weight: bold; }
        .btn:hover { filter: brightness(1.2); transform: translateY(-2px); }
        .input { width: 100%; padding: 12px; margin: 10px 0; border-radius: 8px; border: 1px solid #333; background: #1e1e1e; color: white; box-sizing: border-box; }
        .loader { border: 5px solid #333; border-top: 5px solid #00d4ff; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin-bottom: 20px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

const styles = {
  container: { height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' },
  loginCard: { background: '#111', padding: '40px', borderRadius: '20px', width: '100%', maxWidth: '400px', textAlign: 'center', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' },
  lobbyContainer: { padding: '20px', maxWidth: '1200px', margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111', padding: '15px 25px', borderRadius: '15px', marginBottom: '20px' },
  avatar: { width: '45px', height: '45px', background: '#00d4ff', borderRadius: '50%', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '1.5rem', color: '#000', fontWeight: 'bold' },
  lobbyGrid: { display: 'grid', gridTemplateColumns: '1fr 300px', gap: '20px' },
  mainArea: { background: '#111', padding: '25px', borderRadius: '20px' },
  sideArea: { background: '#111', padding: '25px', borderRadius: '20px' },
  sectionTitle: { fontSize: '1.2rem', fontWeight: 'bold', marginBottom: '15px', color: '#00d4ff', borderLeft: '4px solid #00d4ff', paddingLeft: '10px' },
  tableGrid: { display: 'flex', flexWrap: 'wrap', gap: '10px' },
  chatBox: { background: '#0a0a0a', borderRadius: '15px', padding: '15px', height: '300px', display: 'flex', flexDirection: 'column' },
  chatMsgs: { flex: 1, overflowY: 'auto', marginBottom: '10px', fontSize: '0.9rem' },
  rankList: { display: 'flex', flexDirection: 'column', gap: '10px' },
  rankItem: { display: 'flex', justifyContent: 'space-between', background: '#1e1e1e', padding: '10px 15px', borderRadius: '10px' },
  gameContainer: { maxWidth: '800px', margin: '0 auto', padding: '20px', textAlign: 'center' },
  scoreBoard: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px', padding: '20px', background: '#111', borderRadius: '20px' },
  timerCircle: { width: '70px', height: '70px', borderRadius: '50%', border: '4px solid #00d4ff', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '1.8rem', fontWeight: 'bold', color: '#00d4ff' },
  questionCard: { background: '#111', padding: '30px', borderRadius: '25px', marginBottom: '30px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' },
  optionsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' },
  optionBtn: { padding: '20px', borderRadius: '15px', fontSize: '1.1rem', cursor: 'pointer', color: '#fff', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '15px', transition: '0.2s' },
  optionLetter: { background: '#333', width: '30px', height: '30px', borderRadius: '8px', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '0.9rem', fontWeight: 'bold' },
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', zIndex: 1000 },
};

export default App;