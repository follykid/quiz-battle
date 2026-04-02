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
  serverTimestamp,
  limitToLast,
  query,
} from 'firebase/database';
import { STUDENTS } from './students';

// --- 設定與常數 ---
const QUESTION_TIME = 15;
const QUESTION_COUNT = 10;
const ROOM_TIMEOUT_MS = 60000;          // 改為 60s 給網路更多緩衝
const HEARTBEAT_MS = 15000;             // 15s 更新一次房間心跳
const PRESENCE_TIMEOUT_MS = 90000;      // 90s 沒更新才判定斷線
const USER_STATUS_HEARTBEAT_MS = 30000; // 排行榜心跳 30s
const REVEAL_MS = 1200;                 // 顯示正確答案後的延遲
const AUTH_EMAIL_DOMAIN = 'sshes.tyc.edu.tw';
const TOTAL_TABLES = 14;
const MAX_MESSAGES = 50;

const AI_AVATAR_SRC = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
  <rect width="160" height="160" rx="80" fill="#1e1e1e"/>
  <circle cx="80" cy="80" r="70" fill="#2d2d2d" stroke="#ffeb3b" stroke-width="6"/>
  <text x="80" y="92" font-size="44" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-weight="bold">AI</text>
</svg>
`)}`;

// --- 輔助函式 ---
const dbUpdate = async (path, data) => {
  try { await update(ref(db, path), data); } catch (err) { console.error('Update fail:', err); }
};
const dbSet = async (path, data) => {
  try { await set(ref(db, path), data); } catch (err) { console.error('Set fail:', err); }
};

// 判定是否真的在線 (核心修正)
const isActuallyOnline = (u) => {
  if (!u || !u.online) return false;
  const now = Date.now();
  const lastSeen = u.lastSeen || 0;
  return (now - lastSeen) < 120000; // 2分鐘內有更新才算亮綠燈
};

function App() {
  // --- States ---
  const [user, setUser] = useState(null);
  const [loginId, setLoginId] = useState('');
  const [loginPwd, setLoginPwd] = useState('');
  const [view, setView] = useState('login'); // login, lobby, game
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [inputMsg, setInputMsg] = useState('');
  const [questionStatsList, setQuestionStatsList] = useState([]);
  const [roomsData, setRoomsData] = useState({});

  // 遊戲相關
  const [roomId, setRoomId] = useState('');
  const [myRole, setMyRole] = useState('viewer');
  const [p2Joined, setP2Joined] = useState(false);
  const [isAiMode, setIsAiMode] = useState(false);
  const [allQuestions, setAllQuestions] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selections, setSelections] = useState(null);
  const [timeLeft, setTimeLeft] = useState(QUESTION_TIME);
  const [questionEndsAt, setQuestionEndsAt] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);
  const [roomData, setRoomData] = useState(null);

  const isSwitching = useRef(false);
  const gameOverPlayedRef = useRef(false);
  const BASE = import.meta.env.BASE_URL;

  // --- 音效 ---
  const lobbyBgm = useRef(new Audio(`${BASE}sounds/lobby.mp3`));
  const gameBgm = useRef(new Audio(`${BASE}sounds/game.mp3`));
  const aiBgm = useRef(new Audio(`${BASE}sounds/ai.mp3`));
  const correctSfx = useRef(new Audio(`${BASE}sounds/correct.mp3`));
  const wrongSfx = useRef(new Audio(`${BASE}sounds/wrong.mp3`));
  const winSfx = useRef(new Audio(`${BASE}sounds/win.mp3`));
  const loseSfx = useRef(new Audio(`${BASE}sounds/lose.mp3`));

  const stopAllAudio = useCallback(() => {
    [lobbyBgm, gameBgm, aiBgm, correctSfx, wrongSfx, winSfx, loseSfx].forEach(s => {
      s.current.pause(); s.current.currentTime = 0;
    });
  }, []);

  const avatarSrc = (sid) => {
    if (!sid) return `https://via.placeholder.com/40`;
    if (sid === 'ai') return AI_AVATAR_SRC;
    return `${BASE}avatars/${sid}.jpg`;
  };

  // --- 初始化題庫 ---
  useEffect(() => {
    fetch(`${BASE}quiz.csv?t=${Date.now()}`)
      .then(res => res.text())
      .then(csv => {
        Papa.parse(csv, {
          header: true, skipEmptyLines: true,
          complete: (res) => {
            const formatted = res.data.filter(r => r.question).map(r => ({
              question: r.question,
              options: [
                { text: r.option1, isCorrect: String(r.correct) === '1' },
                { text: r.option2, isCorrect: String(r.correct) === '2' },
                { text: r.option3, isCorrect: String(r.correct) === '3' },
                { text: r.option4, isCorrect: String(r.correct) === '4' },
              ].filter(o => o.text)
            }));
            setAllQuestions(formatted);
            setLoading(false);
          }
        });
      });
  }, [BASE]);

  // --- Auth 監聽 ---
  useEffect(() => {
    return onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) { setView('login'); setUser(null); return; }
      const uid = fbUser.uid;
      const sid = fbUser.email.split('@')[0];
      const student = STUDENTS.find(s => s.id === sid);
      const userRef = ref(db, `users/${uid}`);
      const snap = await get(userRef);
      const data = snap.exists() ? snap.val() : {
        studentId: sid, name: student?.name || sid,
        totalScore: 0, hp: 20, wins: 0, losses: 0,
        isTeacher: sid === 'teacher', online: true, lastSeen: Date.now()
      };
      setUser({ uid, ...data });
      setView('lobby');
    });
  }, []);

  // --- 外部數據監聽 (排行榜, 留言板, 桌子狀態) ---
  useEffect(() => {
    if (!user) return;
    const offLeaderboard = onValue(ref(db, 'users'), (snap) => {
      const val = snap.val() || {};
      setLeaderboard(Object.entries(val).map(([uid, v]) => ({ uid, ...v }))
        .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0)));
    });
    const offMessages = onValue(query(ref(db, 'messages'), limitToLast(MAX_MESSAGES)), (snap) => {
      setMessages(Object.values(snap.val() || {}).sort((a, b) => a.timestamp - b.timestamp));
    });
    const offRooms = onValue(ref(db, 'rooms'), (snap) => {
      setRoomsData(snap.val() || {});
    });
    const offStats = onValue(ref(db, 'questionStats'), (snap) => {
      setQuestionStatsList(Object.entries(snap.val() || {}).map(([q, v]) => ({ q, ...v })));
    });
    return () => { offLeaderboard(); offMessages(); offRooms(); offStats(); };
  }, [user]);

  // --- 在線心跳更新 ---
  useEffect(() => {
    if (!user?.uid) return;
    const hb = setInterval(() => {
      dbUpdate(`users/${user.uid}`, { online: true, lastSeen: serverTimestamp() });
    }, USER_STATUS_HEARTBEAT_MS);
    onDisconnect(ref(db, `users/${user.uid}`)).update({ online: false, lastSeen: serverTimestamp() });
    return () => clearInterval(hb);
  }, [user?.uid]);

  // --- 遊戲房間監聽 ---
  useEffect(() => {
    if (!roomId) return;
    const roomRef = ref(db, `rooms/${roomId}`);
    return onValue(roomRef, (snap) => {
      const data = snap.val();
      if (!data) { setView('lobby'); return; }
      setRoomData(data);
      const role = data.p1Uid === user.uid ? 'p1' : data.p2Uid === user.uid ? 'p2' : 'viewer';
      setMyRole(role);
      setCurrentIdx(data.currentIdx || 0);
      setQuestionEndsAt(data.questionEndsAt || 0);
      setGameOver(!!data.gameOver);
      setSelections(data.selections);
      setP1Score(data.scores?.p1 || 0);
      setP2Score(data.scores?.p2 || 0);
      setP2Joined(!!data.p2Uid);

      if (data.gameOver && !gameOverPlayedRef.current) {
        stopAllAudio();
        const myScore = role === 'p1' ? data.scores.p1 : data.scores.p2;
        const opScore = role === 'p1' ? data.scores.p2 : data.scores.p1;
        (myScore > opScore ? winSfx : loseSfx).current.play();
        gameOverPlayedRef.current = true;
      }
    });
  }, [roomId, user?.uid, stopAllAudio]);

  // --- 倒數計時與 P1 權威切換邏輯 ---
  useEffect(() => {
    if (!questionEndsAt || gameOver) return;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((questionEndsAt - Date.now()) / 1000));
      setTimeLeft(left);
      // 只有 P1 負責在時間到時發送下一題指令
      if (left === 0 && myRole === 'p1' && !isSwitching.current) {
        advanceToNextQuestion();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [questionEndsAt, gameOver, myRole]);

  const advanceToNextQuestion = async () => {
    if (isSwitching.current) return;
    isSwitching.current = true;
    await runTransaction(ref(db, `rooms/${roomId}`), (room) => {
      if (!room) return room;
      const next = room.currentIdx + 1;
      const isFinal = next >= QUESTION_COUNT;
      return {
        ...room,
        currentIdx: isFinal ? room.currentIdx : next,
        gameOver: isFinal,
        selections: null,
        questionEndsAt: Date.now() + QUESTION_TIME * 1000,
        lastActive: serverTimestamp()
      };
    });
    isSwitching.current = false;
  };

  // 兩邊都答完後由 P1 切換
  useEffect(() => {
    if (myRole === 'p1' && selections?.p1 && selections?.p2 && !isSwitching.current && !gameOver) {
      setTimeout(advanceToNextQuestion, REVEAL_MS);
    }
  }, [selections, myRole, gameOver]);

  // --- 玩家動作 ---
  const handleAnswer = async (opt) => {
    if (gameOver || selections?.[myRole] || myRole === 'viewer') return;
    (opt.isCorrect ? correctSfx : wrongSfx).current.play();

    const score = opt.isCorrect ? (timeLeft >= 13 ? 25 : 15 + Math.floor(timeLeft * 0.5)) : 0;
    
    // 更新分數與答案
    const updates = {};
    updates[`rooms/${roomId}/selections/${myRole}`] = { text: opt.text, isCorrect: opt.isCorrect };
    updates[`rooms/${roomId}/scores/${myRole}`] = increment(score);
    updates[`rooms/${roomId}/lastActive`] = serverTimestamp();
    
    // 教師統計
    if (opt.isCorrect === false) {
      const qText = roomData.roomQuestions[currentIdx].question;
      updates[`questionStats/${btoa(encodeURIComponent(qText)).replace(/=/g,'')}/wrongCount`] = increment(1);
    }
    
    await update(ref(db), updates);
  };

  const sendMessage = async () => {
    if (!inputMsg.trim()) return;
    await push(ref(db, 'messages'), {
      uid: user.uid, sid: user.studentId, name: user.name,
      text: inputMsg, timestamp: serverTimestamp()
    });
    setInputMsg('');
  };

  // --- 介面樣式 ---
  const styles = {
    app: { fontFamily: 'sans-serif', background: '#121212', color: '#fff', minHeight: '100vh', display: 'flex', flexDirection: 'column' },
    container: { maxWidth: '1000px', margin: '0 auto', width: '100%', padding: '10px', boxSizing: 'border-box' },
    card: { background: '#1e1e1e', borderRadius: '12px', padding: '15px', marginBottom: '15px', border: '1px solid #333' },
    btn: { padding: '10px 20px', borderRadius: '8px', border: 'none', background: '#3b82f6', color: '#fff', cursor: 'pointer', fontSize: '1rem' },
    input: { padding: '10px', borderRadius: '8px', border: '1px solid #444', background: '#222', color: '#fff', marginBottom: '10px', width: '100%', boxSizing: 'border-box' },
    tableGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px' },
    leaderboardItem: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #333' },
    onlineDot: { width: '10px', height: '10px', background: '#4caf50', borderRadius: '50%', display: 'inline-block', marginLeft: '5px' }
  };

  // --- 畫面組件 ---
  if (loading) return <div style={{ background: '#121212', height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>載入題庫中...</div>;

  return (
    <div style={styles.app}>
      <div style={styles.container}>
        
        {/* --- 登入畫面 --- */}
        {view === 'login' && (
          <div style={{ maxWidth: '400px', margin: '100px auto', textAlign: 'center' }}>
            <h1 style={{ color: '#ffeb3b', fontSize: '2rem' }}>SSHE 知識王 👑</h1>
            <input style={styles.input} placeholder="學號 (例: 110001)" value={loginId} onChange={e => setLoginId(e.target.value)} />
            <input style={styles.input} type="password" placeholder="密碼" value={loginPwd} onChange={e => setLoginPwd(e.target.value)} />
            <button style={{ ...styles.btn, width: '100%' }} onClick={async () => {
              const s = STUDENTS.find(x => x.id === loginId);
              if (!s) return alert('學號不正確');
              try { await signInWithEmailAndPassword(auth, `${loginId}@${AUTH_EMAIL_DOMAIN}`, loginPwd); } catch { alert('密碼錯誤'); }
            }}>進入大廳</button>
          </div>
        )}

        {/* --- 大廳畫面 --- */}
        {view === 'lobby' && (
          <div>
            <div style={{ ...styles.card, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <img src={avatarSrc(user?.studentId)} style={{ width: '45px', borderRadius: '50%' }} alt="avatar" />
                <div>
                  <div style={{ fontWeight: 'bold' }}>{user?.name}</div>
                  <div style={{ fontSize: '0.8rem', color: '#aaa' }}>HP: {user?.hp} | Wins: {user?.wins}</div>
                </div>
              </div>
              <button style={{ ...styles.btn, background: '#ef4444' }} onClick={() => signOut(auth)}>登出</button>
            </div>

            <div style={styles.tableGrid}>
              {Array.from({ length: TOTAL_TABLES }, (_, i) => {
                const tId = `Table_${i + 1}`;
                const r = roomsData[tId];
                const isFull = r?.p1Uid && r?.p2Uid;
                return (
                  <div key={tId} style={{ ...styles.card, textAlign: 'center', cursor: 'pointer', borderColor: isFull ? '#ef4444' : '#3b82f6' }}
                    onClick={() => {
                      if (user.hp < 2) return alert('HP不足 (進入對戰需要 2 HP)');
                      setRoomId(tId);
                      setView('game');
                      dbUpdate(`users/${user.uid}`, { hp: increment(-2) });
                    }}>
                    <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>第 {i + 1} 桌</div>
                    <div style={{ fontSize: '0.8rem', color: isFull ? '#f87171' : '#60a5fa' }}>
                      {isFull ? '對戰中' : r?.p1Uid ? '等待中' : '空席'}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginTop: '15px' }}>
              <div style={styles.card}>
                <h3>🏆 排行榜</h3>
                {leaderboard.slice(0, 15).map((u, i) => (
                  <div key={u.uid} style={styles.leaderboardItem}>
                    <span>{i + 1}. {u.name} {isActuallyOnline(u) && <span style={styles.onlineDot} />}</span>
                    <span style={{ color: '#ffeb3b' }}>{u.totalScore} 💰</span>
                  </div>
                ))}
              </div>
              <div style={styles.card}>
                <h3>💬 留言板</h3>
                <div style={{ height: '200px', overflowY: 'auto', marginBottom: '10px', fontSize: '0.9rem' }}>
                  {messages.map((m, i) => (
                    <div key={i} style={{ marginBottom: '5px' }}>
                      <b style={{ color: '#60a5fa' }}>{m.name}:</b> {m.text}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '5px' }}>
                  <input style={{ ...styles.input, marginBottom: 0 }} value={inputMsg} onChange={e => setInputMsg(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()} />
                  <button style={styles.btn} onClick={sendMessage}>傳送</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* --- 遊戲畫面 --- */}
        {view === 'game' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
               <div style={{ ...styles.card, flex: 1, borderColor: selections?.p1 ? '#4caf50' : '#333' }}>
                 <img src={avatarSrc(roomData?.p1Id)} style={{ width: '60px', borderRadius: '50%' }} />
                 <h4>{roomData?.p1 || 'Player 1'}</h4>
                 <div style={{ fontSize: '1.5rem', color: '#ffeb3b' }}>{p1Score}</div>
               </div>
               <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '0 20px' }}>
                 <div style={{ fontSize: '2.5rem', fontWeight: 'bold', color: timeLeft <= 5 ? '#ef4444' : '#fff' }}>{timeLeft}</div>
                 <div>Round {currentIdx + 1}</div>
               </div>
               <div style={{ ...styles.card, flex: 1, borderColor: selections?.p2 ? '#4caf50' : '#333' }}>
                 <img src={avatarSrc(roomData?.p2Id)} style={{ width: '60px', borderRadius: '50%' }} />
                 <h4>{roomData?.p2 || '等待對手...'}</h4>
                 <div style={{ fontSize: '1.5rem', color: '#ffeb3b' }}>{p2Score}</div>
               </div>
            </div>

            {roomData?.roomQuestions?.[currentIdx] && (
              <div style={styles.card}>
                <h2 style={{ marginBottom: '30px', minHeight: '60px' }}>{roomData.roomQuestions[currentIdx].question}</h2>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                  {roomData.roomQuestions[currentIdx].options.map((opt, i) => {
                    const mySel = selections?.[myRole];
                    const isMyChoice = mySel?.text === opt.text;
                    const showCorrect = mySel && opt.isCorrect;
                    const showWrong = isMyChoice && !opt.isCorrect;

                    return (
                      <button key={i} style={{
                        ...styles.btn,
                        padding: '20px',
                        fontSize: '1.1rem',
                        background: showCorrect ? '#4caf50' : showWrong ? '#ef4444' : (mySel ? '#333' : '#3b82f6'),
                        opacity: mySel && !isMyChoice && !opt.isCorrect ? 0.5 : 1
                      }} disabled={!!mySel} onClick={() => handleAnswer(opt)}>
                        {opt.text}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* --- 結算 Overlay --- */}
        {gameOver && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', zIndex: 100 }}>
            <h1 style={{ fontSize: '4rem', color: '#ffeb3b' }}>遊戲結束!</h1>
            <div style={{ fontSize: '2rem', marginBottom: '30px' }}>
              你的分數: {myRole === 'p1' ? p1Score : p2Score}
            </div>
            <button style={{ ...styles.btn, fontSize: '1.5rem', padding: '15px 40px', background: '#4caf50' }} onClick={async () => {
               // 房主負責清空房間
               if (myRole === 'p1') {
                 await remove(ref(db, `rooms/${roomId}`));
                 // 更新最終英雄榜分數
                 dbUpdate(`users/${user.uid}`, { totalScore: increment(p1Score) });
               } else {
                 dbUpdate(`users/${user.uid}`, { totalScore: increment(p2Score) });
               }
               setView('lobby');
               setRoomId('');
               setGameOver(false);
               gameOverPlayedRef.current = false;
            }}>回到大廳</button>
          </div>
        )}

      </div>
    </div>
  );
}

export default App;