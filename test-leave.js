
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3001');
const log = [];
const timeout = setTimeout(() => { console.log('TIMEOUT', JSON.stringify(log)); process.exit(1); }, 6000);
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'setname', name: '测试成员' }));
  ws.send(JSON.stringify({ t: 'list' }));
});
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  log.push(m.t + (m.t === 'table' ? ':' + m.table.id + ':seats=' + m.table.seats.filter(Boolean).length : ''));
  if (m.t === 'tables') {
    // 找一个 endless 空桌（0人）加入；若没有就加入任一座位未满的
    let target = null;
    for (const t of m.tables) {
      if (t.mode === 'endless') {
        const filled = t.seats.filter(Boolean).length;
        if (filled === 0 && t.state === 'lobby') { target = t; break; }
      }
    }
    if (!target) { for (const t of m.tables) { if (t.mode === 'endless' && t.state === 'lobby') { target = t; break; } } }
    if (target) { ws.send(JSON.stringify({ t: 'join', tableId: target.id })); }
    else { console.log('NO_EMPTY_TABLE', JSON.stringify(log)); process.exit(1); }
    return;
  }
  if (m.t === 'table' && log.filter(l => l.startsWith('left')).length === 0) {
    const mySeat = m.table.seats.findIndex(s => s && s.name === '测试成员');
    // 加入成功后离开
    if (mySeat >= 0) {
      ws.send(JSON.stringify({ t: 'leave' }));
    }
    return;
  }
  if (m.t === 'left') {
    clearTimeout(timeout);
    console.log('LEFT_RECEIVED', JSON.stringify(log));
    process.exit(0);
  }
});
