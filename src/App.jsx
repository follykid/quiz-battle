import React, { useState, useEffect, useRef } from 'react';
import Papa from 'papaparse'; 
import { db } from './firebase'; 
import { ref, onValue, update, set, get, push, serverTimestamp, increment, remove, onDisconnect } from "firebase/database";
import { STUDENTS } from './students'; 

function App() {
  const [user, setUser] = useState(null); 
  const [loginId, setLoginId] = useState("");
  const [loginPwd, setLoginPwd] = useState("");
  const [view, setView] = useState("login"); 
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [inputMsg, setInputMsg] = useState("");

  const [roomId, setRoomId] = useState(""); 
  const [myRole, setMyRole] = useState("viewer"); 
  const [p2Joined, setP2Joined] = useState(false);
  const [isAiMode, setIsAiMode] = useState(false); 
  const [questions, setQuestions] = useState([]); 
  const [allQuestions, setAllQuestions] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selections, setSelections] = useState(null);
  const [timeLeft, setTimeLeft] = useState(15);
  const [gameOver, setGameOver] = useState(false);
  const [p1Score, setP1Score] = useState(0);
  const [p2Score, setP2Score] = useState(0);
  const [p1Name, setP1Name] = useState("");
  const [p2Name, setP2Name] = useState("");

  const isSwitching = useRef(false);

  const correctSfx = useRef(new Audio('sounds/correct.mp3'));
  const wrongSfx = useRef(new Audio('sounds/wrong.mp3'));
  const lobbyBgm = useRef(new Audio('sounds/lobby.mp3'));
  const battleBgm = useRef(new Audio('sounds/battle.mp3'));

  useEffect(() => {
    lobbyBgm.current.loop = true;
    battleBgm.current.loop = true;
    lobbyBgm.current.volume = 0.4;
    battleBgm.current.volume = 0.5;
  }, []);

  useEffect(() => {
    if (!user) return;
    if (view === "lobby") {
      battleBgm.current.pause();
      battleBgm.current.currentTime = 0;
      lobbyBgm.current.play().catch(e => {});
    } else if (view === "game") {
      lobbyBgm.current.pause();
      lobbyBgm.current.currentTime = 0;
      battleBgm.current.play().catch(e => {});
    } else {
      lobbyBgm.current.pause();
      battleBgm.current.pause();
    }
  }, [view, user]);

  const calcWinRate = (w = 0, l = 0) => {
    const total = (w || 0) + (l || 0);
    return total === 0 ? "0%" : ((w / total) * 100).toFixed(1) + "%";
  };

  useEffect(() => {
    onValue(ref(db, 'users'), (snap) => {
      const val = snap.val() || {};
      const list = Object.entries(val).map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0)).slice(0, 15);
      setLeaderboard(list);
      if (user?.id && !user.isTeacher) {
        const me = val[user.id];
        if (me) setUser(prev => ({ ...prev, totalScore: me.totalScore, hp: me.hp, wins: me.wins || 0, losses: me.losses || 0 }));
      }
    });
    // 修正：增加 timestamp 排序確保最新留言在最下面
    onValue(ref(db, 'messages'), (snap) => {
      if (snap.exists()) {
        const msgs = Object.values(snap.val());
        setMessages(msgs.slice(-20)); // 取最後 20 則
      }
    });
    
    fetch('quiz.csv').then(res => res.text()).then(result => {
      Papa.parse(result, {
        header: true, skipEmptyLines: true,
        complete: (res) => {
          const formatted = res.data.filter(r => r.question).map(r => ({
            question: r.question,
            options: [
              { text: r.option1, isCorrect: String(r.correct) === "1" },
              { text: r.option2, isCorrect: String(r.correct) === "2" },
              { text: r.option3, isCorrect: String(r.correct) === "3" },
              { text: r.option4, isCorrect: String(r.correct) === "4" },
            ].filter(o => o.text)
          }));
          setAllQuestions(formatted);
          setLoading(false);
        }
      });
    });
  }, [user?.id]);

  const handleLogin = async () => {
    const student = STUDENTS.find(s => s.id === loginId);
    if (!student || student.password !== loginPwd) return alert("學號或密碼錯誤！");
    const userRef = ref(db, `users/${loginId}`);
    const snap = await get(userRef);
    let userData = snap.exists() ? snap.val() : { name: student.name, totalScore: 0, hp: 20, wins: 0, losses: 0 };
    if (!snap.exists()) await set(userRef, userData);
    setUser({ id: loginId, ...userData, isTeacher: false });
    setView("lobby");
  };

  const exchangeHp = async () => {
    if (user.totalScore < 15) return alert("積分不足 15 分！");
    const userRef = ref(db, `users/${user.id}`);
    await update(userRef, { totalScore: increment(-15), hp: increment(1) });
    alert("兌換成功！HP +1");
  };

  const resetTable = async (num) => {
    if(window.confirm(`確定要清空「桌 ${num}」嗎？`)) {
      await remove(ref(db, `rooms/Table_${num}`));
    }
  };

  const startAiGame = async () => {
    if (Number(user.hp) < 4) return alert("HP 不足 4 點！");
    const tid = `AI_${user.id}_${Date.now()}`;
    const roomRef = ref(db, `rooms/${tid}`);
    const shuffled = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, 10);
    try {
      await set(roomRef, { p1: user.name, p2: "🤖 練習用 AI", roomQuestions: shuffled, currentIdx: 0, scores: {p1:0, p2:0}, gameOver: false, lastActive: Date.now() });
      await update(ref(db, `users/${user.id}`), { hp: increment(-4) });
      setQuestions(shuffled); setMyRole("p1"); setRoomId(tid); setIsAiMode(true); setP2Joined(true); setP2Name("🤖 練習用 AI"); setView("game");
    } catch(e) { alert("連線失敗"); }
  };

  const handleJoinTable = async (num) => {
    if (Number(user.hp) < 2) return alert("HP 不足 2 點！");
    const tid = `Table_${num}`;
    const roomRef = ref(db, `rooms/${tid}`);
    const snap = await get(roomRef);
    const roomData = snap.val();
    const isInactive = !roomData || (Date.now() - (roomData.lastActive || 0) > 30000);
    try {
      if (isInactive || roomData.gameOver || !roomData.p1) {
        await remove(roomRef);
        const shuffled = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, 10);
        await set(roomRef, { p1: user.name, p2: false, roomQuestions: shuffled, currentIdx: 0, scores: {p1:0, p2:0}, gameOver: false, lastActive: Date.now() });
        onDisconnect(roomRef).remove(); 
        await update(ref(db, `users/${user.id}`), { hp: increment(-2) });
        setQuestions(shuffled); setMyRole("p1"); setRoomId(tid); setIsAiMode(false); setView("game");
      } else {
        if (roomData.p1 === user.name) return alert("你已在房內");
        if (roomData.p2) return alert("此房間已滿");
        await update(roomRef, { p2: user.name, lastActive: Date.now() });
        await update(ref(db, `users/${user.id}`), { hp: increment(-2) });
        setMyRole("p2"); setRoomId(tid); setQuestions(roomData.roomQuestions); setIsAiMode(false); setView("game");
      }
    } catch(e) { alert("進入失敗"); }
  };

  useEffect(() => {
    if (!roomId) return;
    const roomRef = ref(db, `rooms/${roomId}`);
    return onValue(roomRef, (snap) => {
      const data = snap.val();
      if (!data) return;
      if (myRole === 'p1') update(roomRef, { lastActive: Date.now() });
      setP1Name(data.p1); setP2Name(data.p2); setP2Joined(!!data.p2);
      setSelections(data.selections || null); setCurrentIdx(data.currentIdx || 0);
      if (data.scores) { setP1Score(data.scores.p1 || 0); setP2Score(data.scores.p2 || 0); }
      setGameOver(!!data.gameOver);
      if (data.roomQuestions && questions.length === 0) setQuestions(data.roomQuestions);
      
      // 控制跳題時間，讓正確答案顯示 1.2 秒
      if (data.selections?.p1 && data.selections?.p2 && !data.gameOver && !isSwitching.current && myRole === 'p1') {
        isSwitching.current = true;
        setTimeout(() => {
          const nextIdx = (data.currentIdx || 0) + 1;
          if (nextIdx < (data.roomQuestions?.length || 10)) {
            update(roomRef, { currentIdx: nextIdx, selections: null, lastActive: Date.now() });
          } else { update(roomRef, { gameOver: true }); }
          isSwitching.current = false;
        }, 1200); 
      }
    });
  }, [roomId, myRole]);

  useEffect(() => {
    if (isAiMode && selections?.p1 && !selections?.p2 && !gameOver) {
      setTimeout(() => {
        const q = questions[currentIdx];
        const correctOpt = q.options.find(o => o.isCorrect);
        const wrongOpts = q.options.filter(o => !o.isCorrect);
        const aiOpt = Math.random() < 0.6 ? correctOpt : wrongOpts[Math.floor(Math.random() * wrongOpts.length)];
        update(ref(db, `rooms/${roomId}`), { "selections/p2": { text: aiOpt.text, isCorrect: aiOpt.isCorrect }, "scores/p2": p2Score + (aiOpt.isCorrect ? 10 : 0), lastActive: Date.now() });
      }, 800);
    }
  }, [selections, isAiMode]);

  const onSelect = (opt) => {
    if (selections?.[myRole] || (!p2Joined && !isAiMode) || gameOver) return;
    if (opt.isCorrect) { correctSfx.current.currentTime = 0; correctSfx.current.play(); } 
    else { wrongSfx.current.currentTime = 0; wrongSfx.current.play(); }
    let score = opt.isCorrect ? (timeLeft >= 13 ? 20 : 10) + Math.floor(timeLeft * 0.5) : 0;
    update(ref(db, `rooms/${roomId}`), { [`selections/${myRole}`]: { text: opt.text, isCorrect: opt.isCorrect }, [`scores/${myRole}`]: (myRole === 'p1' ? p1Score : p2Score) + score, lastActive: Date.now() });
  };

  useEffect(() => { if ((p2Joined || isAiMode) && !gameOver) setTimeLeft(15); }, [currentIdx, p2Joined, isAiMode, gameOver]);
  useEffect(() => {
    if (gameOver || (!p2Joined && !isAiMode) || selections?.[myRole]) return;
    const timer = setInterval(() => { setTimeLeft(t => (t <= 1 ? 0 : t - 1)); }, 1000);
    return () => clearInterval(timer);
  }, [currentIdx, gameOver, p2Joined, isAiMode, selections]);

  const finishGameAndGoLobby = async () => {
    const myScore = myRole === 'p1' ? p1Score : p2Score;
    const oppScore = myRole === 'p1' ? p2Score : p1Score;
    const isWin = myScore > oppScore;
    const updates = {};
    if (isAiMode) { if (isWin) updates[`users/${user.id}/totalScore`] = increment(Math.floor(myScore * 0.4)); } 
    else {
      updates[`users/${user.id}/totalScore`] = increment(myScore + (isWin ? 20 : 5));
      updates[`users/${user.id}/hp`] = increment(isWin ? 5 : -1);
      updates[`users/${user.id}/wins`] = increment(isWin ? 1 : 0);
      updates[`users/${user.id}/losses`] = increment(isWin ? 0 : 1);
    }
    await update(ref(db), updates);
    if (myRole === 'p1') await remove(ref(db, `rooms/${roomId}`)); 
    setRoomId(""); setGameOver(false); setView("lobby");
  };

  const sendMessage = () => {
    if (!inputMsg.trim()) return;
    // 修正：發送留言時加入 timestamp
    push(ref(db, 'messages'), { user: user.name, text: inputMsg, timestamp: Date.now() })
      .then(() => setInputMsg(""))
      .catch(e => alert("發送失敗，請檢查 Firebase 權限！"));
  };

  if (loading) return <div style={{color:'white', textAlign:'center', marginTop:'50px'}}>載入中...</div>;

  return (
    <div className="safe-container">
      <style>{`
        html, body { background: #121212; margin: 0; padding: 0; overflow-y: auto !important; height: auto; min-height: 100%; }
        .safe-container { min-height: 100vh; color: white; font-family: sans-serif; display: flex; flex-direction: column; }
        .box { background: #1e1e1e; padding: 20px; border-radius: 15px; border: 1px solid #333; margin-bottom: 10px; }
        .btn { padding: 12px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; transition: 0.2s; }
        .quiz-title { font-size: 1.8rem; margin-bottom: 25px; color: #ffeb3b; font-weight: bold; }
        .option-btn { padding: 20px; font-size: 1.2rem; border-radius: 12px; border: none; color: white; background: #333; margin-bottom: 10px; width: 100%; text-align: left; transition: 0.3s; }
        header { position: sticky; top: 0; z-index: 1000; background: #1e1e1e; padding: 10px 15px; border-bottom: 2px solid #333; }
        .msg-box { height: 250px; overflow-y: auto; background: #111; padding: 15px; border-radius: 10px; margin-bottom: 10px; border: 1px solid #333; display: flex; flex-direction: column-reverse; }
      `}</style>

      {view === "login" && (
        <div style={{ padding: '80px 20px', textAlign: 'center' }}>
          <h1>⚔️ 知識對戰系統</h1>
          <div className="box" style={{ maxWidth: '320px', margin: '0 auto' }}>
            <input placeholder="學號" value={loginId} onChange={e=>setLoginId(e.target.value)} style={{width:'100%', padding:'12px', marginBottom:'15px', background:'#111', color:'white', border:'1px solid #444', borderRadius:'8px', boxSizing:'border-box'}} />
            <input type="password" placeholder="密碼" value={loginPwd} onChange={e=>setLoginPwd(e.target.value)} style={{width:'100%', padding:'12px', marginBottom:'25px', background:'#111', color:'white', border:'1px solid #444', borderRadius:'8px', boxSizing:'border-box'}} />
            <button className="btn" onClick={handleLogin} style={{width:'100%', background:'#4caf50', color:'white'}}>登入</button>
          </div>
        </div>
      )}

      {user && view !== "login" && (
        <>
          <header>
             <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
               <div>👤 <b>{user.name}</b> <span style={{color:'#ff5252', marginLeft:'10px'}}>❤️ {user.hp}</span> <span style={{color:'#ffeb3b', marginLeft:'10px'}}>💰 {user.totalScore}</span></div>
               <button onClick={()=>window.location.reload()} className="btn" style={{background:'#555', color:'white', padding:'5px 12px'}}>登出</button>
             </div>
          </header>

          <main style={{ flex: 1, padding: '15px' }}>
            {view === "lobby" && (
              <div style={{maxWidth:'800px', margin:'0 auto'}}>
                <div className="box" style={{textAlign:'center', border:'1px solid #ff5252'}}>
                    <h3>🤖 AI 練習 (4 HP)</h3>
                    <button className="btn" onClick={startAiGame} style={{background:'#ff5252', color:'white', width:'100%'}}>進入對戰</button>
                </div>
                <div className="box">
                  <h3 style={{textAlign:'center'}}>🎮 真人對戰桌 (2 HP)</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(85px, 1fr))', gap: '8px' }}>
                    {Array.from({ length: 14 }).map((_, i) => (
                      <div key={i} style={{position:'relative'}}>
                        <button className="btn" onClick={() => handleJoinTable(i+1)} style={{background:'#2c2c2c', color:'white', border:'1px solid #444', width:'100%'}}>桌 {i+1}</button>
                        <button onClick={() => resetTable(i+1)} style={{position:'absolute', top:'-5px', right:'-5px', background:'#444', borderRadius:'50%', border:'none', color:'white', width:'18px', height:'18px', fontSize:'9px'}}>🧹</button>
                      </div>
                    ))}
                  </div>
                </div>
                
                <div className="box">
                   <h3 style={{marginTop:0}}>💬 班級留言板</h3>
                   <div className="msg-box">
                     {[...messages].reverse().map((m, i) => (
                       <div key={i} style={{marginBottom:'8px'}}><b style={{color:'#4caf50'}}>{m.user}</b>: {m.text}</div>
                     ))}
                   </div>
                   <div style={{display:'flex', gap:'5px'}}>
                     <input value={inputMsg} onChange={e=>setInputMsg(e.target.value)} onKeyPress={e=>e.key==='Enter'&&sendMessage()} style={{flex:1, padding:'10px', borderRadius:'8px', background:'#333', border:'none', color:'white'}} placeholder="輸入留言..." />
                     <button onClick={sendMessage} className="btn" style={{background:'#4caf50', color:'white'}}>發送</button>
                   </div>
                </div>
              </div>
            )}

            {view === "game" && (
              <div style={{ maxWidth: '800px', margin: '0 auto' }}>
                <div style={{textAlign:'center', marginBottom:'20px'}}>
                  <div style={{fontSize:'3rem', fontWeight:'bold'}}>{timeLeft}s</div>
                  <div style={{display:'flex', justifyContent:'space-around', background:'#1e1e1e', padding:'15px', borderRadius:'15px'}}>
                    <div><div style={{fontSize:'2rem', color:'#4caf50'}}>{p1Score}</div><small>{p1Name}</small></div>
                    <div style={{fontSize:'2rem'}}>VS</div>
                    <div><div style={{fontSize:'2rem', color:'#2196f3'}}>{p2Score}</div><small>{p2Name}</small></div>
                  </div>
                </div>

                {(p2Joined || isAiMode) ? (
                  questions[currentIdx] && (
                    <div className="box">
                      <div className="quiz-title">Q{currentIdx + 1}: {questions[currentIdx].question}</div>
                      {questions[currentIdx].options.map((opt, i) => {
                        // 🟢 判斷背景顏色：點選後顯示答案
                        let bg = '#333'; 
                        if (selections?.[myRole]) {
                          if (opt.isCorrect) bg = '#2e7d32'; // 正確答案顯示綠色
                          else if (selections[myRole].text === opt.text) bg = '#c62828'; // 選錯的顯示紅色
                        }
                        return (
                          <button key={i} onClick={() => onSelect(opt)} disabled={!!selections?.[myRole]} className="option-btn"
                            style={{ background: bg, border: selections?.[myRole]?.text === opt.text ? '2px solid white' : 'none' }}>
                            {opt.text}
                          </button>
                        );
                      })}
                    </div>
                  )
                ) : (
                  <div style={{textAlign:'center', padding:'50px'}}>⏳ 等待對手加入...</div>
                )}
              </div>
            )}
          </main>

          {gameOver && (
            <div style={{ position:'fixed', top:0, left:0, width:'100%', height:'100%', background:'rgba(0,0,0,0.9)', display:'flex', flexDirection:'column', justifyContent:'center', alignItems:'center', zIndex:2000 }}>
              <h1 style={{fontSize:'3.5rem', color: (myRole==='p1'?p1Score:p2Score) > (myRole==='p1'?p2Score:p1Score) ? '#ffeb3b' : '#ff5252'}}>
                {(myRole==='p1'?p1Score:p2Score) > (myRole==='p1'?p2Score:p1Score) ? "勝利！" : "再接再厲"}
              </h1>
              <button className="btn" onClick={finishGameAndGoLobby} style={{background:'#4caf50', color:'white', padding:'10px 40px'}}>領取獎勵並返回大廳</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;