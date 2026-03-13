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
  // 新增：儲存對手學號以便顯示頭像
  const [p1Id, setP1Id] = useState("");
  const [p2Id, setP2Id] = useState("");

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

    onValue(ref(db, 'messages'), (snap) => {
      if (snap.exists()) {
        const msgs = Object.values(snap.val());
        setMessages(msgs); 
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
      await set(roomRef, { p1: user.name, p1Id: user.id, p2: "🤖 練習用 AI", p2Id: "ai", roomQuestions: shuffled, currentIdx: 0, scores: {p1:0, p2:0}, gameOver: false, lastActive: Date.now() });
      await update(ref(db, `users/${user.id}`), { hp: increment(-4) });
      setQuestions(shuffled); setMyRole("p1"); setRoomId(tid); setIsAiMode(true); setP2Joined(true); setP2Name("🤖 練習用 AI"); setP2Id("ai"); setView("game");
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
        await set(roomRef, { p1: user.name, p1Id: user.id, p2: false, roomQuestions: shuffled, currentIdx: 0, scores: {p1:0, p2:0}, gameOver: false, lastActive: Date.now() });
        onDisconnect(roomRef).remove(); 
        await update(ref(db, `users/${user.id}`), { hp: increment(-2) });
        setQuestions(shuffled); setMyRole("p1"); setRoomId(tid); setIsAiMode(false); setView("game");
      } else {
        if (roomData.p1 === user.name) return alert("你已在房內");
        if (roomData.p2) return alert("此房間已滿");
        await update(roomRef, { p2: user.name, p2Id: user.id, lastActive: Date.now() });
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
      setP1Name(data.p1); setP1Id(data.p1Id); setP2Name(data.p2); setP2Id(data.p2Id); setP2Joined(!!data.p2);
      setSelections(data.selections || null); setCurrentIdx(data.currentIdx || 0);
      if (data.scores) { setP1Score(data.scores.p1 || 0); setP2Score(data.scores.p2 || 0); }
      setGameOver(!!data.gameOver);
      if (data.roomQuestions && questions.length === 0) setQuestions(data.roomQuestions);
      
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
    let rewardPoints = isAiMode ? (isWin ? Math.floor(myScore * 0.5) : Math.floor(myScore * 0.3)) : (isWin ? myScore : Math.floor(myScore * 0.8));
    if (!isAiMode && isWin) updates[`users/${user.id}/hp`] = increment(5);
    if (!isAiMode) { updates[`users/${user.id}/wins`] = increment(isWin ? 1 : 0); updates[`users/${user.id}/losses`] = increment(isWin ? 0 : 1); }
    updates[`users/${user.id}/totalScore`] = increment(rewardPoints);
    await update(ref(db), updates);
    if (myRole === 'p1') await remove(ref(db, `rooms/${roomId}`)); 
    setRoomId(""); setGameOver(false); setView("lobby");
  };

  const sendMessage = () => {
    if (!inputMsg.trim()) return;
    push(ref(db, 'messages'), { user: user.name, text: inputMsg, timestamp: Date.now() }).then(() => setInputMsg(""));
  };

  if (loading) return <div style={{color:'white', textAlign:'center', marginTop:'50px'}}>載入中...</div>;

  return (
    <div className="safe-container">
      <style>{`
        html, body { background: #121212; margin: 0; padding: 0; font-family: sans-serif; }
        .safe-container { min-height: 100vh; color: white; display: flex; flex-direction: column; }
        .box { background: #1e1e1e; padding: 20px; border-radius: 15px; border: 1px solid #333; margin-bottom: 10px; }
        .btn { padding: 12px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; transition: 0.2s; }
        .avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid #444; }
        .avatar-lg { width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 3px solid #ffeb3b; }
        .rank-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
        .rank-table td { padding: 8px 5px; border-bottom: 1px solid #222; vertical-align: middle; }
        .lobby-layout { display: grid; grid-template-columns: 300px 1fr; gap: 20px; max-width: 1200px; margin: 0 auto; width: 100%; box-sizing: border-box; padding: 10px; }
        @media (max-width: 850px) { .lobby-layout { grid-template-columns: 1fr; } }
        .option-btn { padding: 20px; font-size: 1.2rem; border-radius: 12px; border: none; color: white; background: #333; margin-bottom: 10px; width: 100%; text-align: left; }
        header { position: sticky; top: 0; z-index: 1000; background: #1e1e1e; padding: 10px 15px; border-bottom: 2px solid #333; display: flex; justify-content: space-between; align-items: center; }
        .msg-box { height: 300px; overflow-y: auto; background: #111; padding: 15px; border-radius: 10px; margin-bottom: 10px; border: 1px solid #333; }
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
             <div style={{display:'flex', alignItems:'center', gap:'10px'}}>
               <img src={`avatars/${user.id}.jpg`} className="avatar" onError={(e)=>e.target.src='https://via.placeholder.com/40'} />
               <b>{user.name}</b>
               <span style={{color:'#ff5252', marginLeft:'5px'}}>❤️ {user.hp}</span>
               <span style={{color:'#ffeb3b', marginLeft:'5px'}}>💰 {user.totalScore}</span>
             </div>
             <div style={{display:'flex', gap:'8px'}}>
               <button onClick={exchangeHp} className="btn" style={{background:'#4caf50', color:'white', padding:'5px 10px', fontSize:'0.8rem'}}>換血</button>
               <button onClick={()=>window.location.reload()} className="btn" style={{background:'#555', color:'white', padding:'5px 10px', fontSize:'0.8rem'}}>登出</button>
             </div>
          </header>

          <main style={{ flex: 1 }}>
            {view === "lobby" && (
              <div className="lobby-layout">
                <div className="box">
                  <h3 style={{ color: '#ffeb3b', textAlign: 'center', marginTop:0 }}>🏆 榮譽榜</h3>
                  <table className="rank-table">
                    <tbody>
                      {leaderboard.map((u, i) => (
                        <tr key={i}>
                          <td width="30">{i+1}</td>
                          <td width="50"><img src={`avatars/${u.id}.jpg`} className="avatar" onError={(e)=>e.target.src='https://via.placeholder.com/40'} /></td>
                          <td>{u.name}<br/><small style={{color:'#4caf50'}}>{u.totalScore} pts</small></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div>
                  <div className="box" style={{textAlign:'center', border:'1px solid #ff5252'}}>
                      <button className="btn" onClick={startAiGame} style={{background:'#ff5252', color:'white', width:'100%'}}>🤖 AI 練習對戰 (4 HP)</button>
                  </div>
                  <div className="box">
                    <h4 style={{textAlign:'center', marginTop:0}}>🎮 真人對戰桌 (2 HP)</h4>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: '8px' }}>
                      {Array.from({ length: 14 }).map((_, i) => (
                        <button key={i} className="btn" onClick={() => handleJoinTable(i+1)} style={{background:'#2c2c2c', color:'white', border:'1px solid #444'}}>桌 {i+1}</button>
                      ))}
                    </div>
                  </div>
                  <div className="box">
                     <h4 style={{marginTop:0}}>💬 班級留言板</h4>
                     <div className="msg-box">
                       {messages.slice().reverse().map((m, i) => (
                         <div key={i} style={{marginBottom:'8px'}}><b style={{color:'#4caf50'}}>{m.user}</b>: {m.text}</div>
                       ))}
                     </div>
                     <div style={{display:'flex', gap:'5px'}}>
                       <input value={inputMsg} onChange={e=>setInputMsg(e.target.value)} onKeyPress={e=>e.key==='Enter'&&sendMessage()} style={{flex:1, padding:'10px', borderRadius:'8px', background:'#333', border:'none', color:'white'}} placeholder="聊天..." />
                       <button onClick={sendMessage} className="btn" style={{background:'#4caf50', color:'white'}}>發送</button>
                     </div>
                  </div>
                </div>
              </div>
            )}

            {view === "game" && (
              <div style={{ maxWidth: '800px', margin: '0 auto', padding:'10px' }}>
                <div style={{textAlign:'center', marginBottom:'20px'}}>
                  <div style={{fontSize:'3rem', fontWeight:'bold'}}>{timeLeft}s</div>
                  <div style={{display:'flex', justifyContent:'space-around', alignItems:'center', background:'#1e1e1e', padding:'15px', borderRadius:'15px'}}>
                    <div>
                      <img src={p1Id === 'ai' ? 'https://via.placeholder.com/80?text=AI' : `avatars/${p1Id}.jpg`} className="avatar-lg" onError={(e)=>e.target.src='https://via.placeholder.com/80'} />
                      <div style={{fontSize:'1.5rem', color:'#4caf50'}}>{p1Score}</div><small>{p1Name}</small>
                    </div>
                    <div style={{fontSize:'2rem'}}>VS</div>
                    <div>
                      <img src={p2Id === 'ai' ? 'https://via.placeholder.com/80?text=AI' : `avatars/${p2Id}.jpg`} className="avatar-lg" onError={(e)=>e.target.src='https://via.placeholder.com/80'} />
                      <div style={{fontSize:'1.5rem', color:'#2196f3'}}>{p2Score}</div><small>{p2Name}</small>
                    </div>
                  </div>
                </div>
                {(p2Joined || isAiMode) ? (
                  questions[currentIdx] && (
                    <div className="box">
                      <div className="quiz-title">Q{currentIdx + 1}: {questions[currentIdx].question}</div>
                      {questions[currentIdx].options.map((opt, i) => (
                        <button key={i} onClick={() => onSelect(opt)} disabled={!!selections?.[myRole]} className="option-btn"
                          style={{ background: selections?.[myRole] ? (opt.isCorrect ? '#2e7d32' : (selections[myRole].text === opt.text ? '#c62828' : '#333')) : '#333' }}>
                          {opt.text}
                        </button>
                      ))}
                    </div>
                  )
                ) : <div style={{textAlign:'center', padding:'50px'}}>⏳ 等待對手...</div>}
              </div>
            )}
          </main>

          {gameOver && (
            <div style={{ position:'fixed', top:0, left:0, width:'100%', height:'100%', background:'rgba(0,0,0,0.95)', display:'flex', flexDirection:'column', justifyContent:'center', alignItems:'center', zIndex:2000, textAlign:'center' }}>
              <h1 style={{fontSize:'3.5rem', color: (myRole==='p1'?p1Score:p2Score) > (myRole==='p1'?p2Score:p1Score) ? '#ffeb3b' : '#ff5252'}}>
                {(myRole==='p1'?p1Score:p2Score) > (myRole==='p1'?p2Score:p1Score) ? "YOU WIN! 🎉" : "GAME OVER 💀"}
              </h1>
              <button className="btn" onClick={finishGameAndGoLobby} style={{background:'#4caf50', color:'white', padding:'15px 50px', fontSize:'1.2rem'}}>返回大廳</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;