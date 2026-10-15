import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export function Dice({ dice }) {
  if (!dice) return null;
  const pips = [[4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
  const rotations = ['rotateX(0deg)', 'rotateX(-90deg)', 'rotateY(-90deg)', 'rotateY(90deg)', 'rotateX(90deg)', 'rotateY(180deg)'];
  return <div className="dice-result" role="status" aria-label={`掷骰结果 ${dice.values.join('、')}，合计 ${dice.values[0] + dice.values[1]} 点`}>
    <span>本局骰子</span><div className="dice-pair" key={dice.id} aria-hidden="true">{dice.values.map((value, index) => <div className={`die-view die-${index}`} key={index}><div className="die-tumble"><div className="die" style={{ transform: rotations[value - 1] }}>{pips.map((face, side) => <div className={`die-face die-face-${side + 1}`} key={side}>{Array.from({ length: 9 }, (_, pip) => <i key={pip} className={face.includes(pip) ? 'pip' : ''} />)}</div>)}</div></div></div>)}</div><strong>{dice.values[0] + dice.values[1]} 点</strong>
  </div>;
}

export function useRiichiVoice(room, me) {
  const [voices, setVoices] = useState([]);
  const [selected, setSelected] = useState(() => { try { return localStorage.getItem('riichi-voice') || ''; } catch { return ''; } });
  const [error, setError] = useState('');
  const audio = useRef(null);
  const seen = useRef(new Set(room.events.map((event) => event.id)));
  const refresh = useCallback((signal) => {
    api('/riichi-voices', { signal }).then(setVoices).catch((e) => { if (!signal?.aborted) setError(e.message); });
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const reload = () => refresh(abort.signal);
    reload();
    window.addEventListener('focus', reload);
    window.addEventListener('dianque:voices-changed', reload);
    return () => { abort.abort(); audio.current?.pause(); window.removeEventListener('focus', reload); window.removeEventListener('dianque:voices-changed', reload); };
  }, [refresh]);
  const voice = voices.find((item) => item.id === selected);
  function play(item) {
    if (!item) return;
    audio.current ||= new Audio();
    audio.current.pause(); audio.current.src = item.url;
    audio.current.play().then(() => setError('')).catch(() => setError('浏览器尚未允许声音，或音频无法播放。请在牌桌设置中点击试听。'));
  }
  function choose(id) {
    setSelected(id); setError(''); audio.current?.pause();
    try { localStorage.setItem('riichi-voice', id); } catch { /* 浏览器禁用存储时，本次选择仍然生效。 */ }
    play(voices.find((item) => item.id === id));
  }
  useEffect(() => {
    const fresh = room.events.filter((event) => !seen.current.has(event.id));
    room.events.forEach((event) => seen.current.add(event.id));
    if (fresh.some((event) => event.type === 'riichi' && event.seat === me.seat && !event.undone && Date.now() - Date.parse(event.at) < 10000)) play(voice);
  }, [room.events, me.seat]);
  return { voices, selected: voice?.id || '', choose, play: () => play(voice), refresh, error };
}

export function VoiceSettings({ voice }) {
  useEffect(() => { const abort = new AbortController(); voice.refresh(abort.signal); return () => abort.abort(); }, [voice.refresh]);
  return <section className="voice-settings"><label>立直语音<select value={voice.selected} onChange={(e) => voice.choose(e.target.value)}><option value="">关闭</option>{voice.voices.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <p className="field-help">仅自己立直时在本设备播放，选择后可试听。</p>
    {voice.voices.length ? <button className="text-button" disabled={!voice.voices.some((item) => item.id === voice.selected)} onClick={voice.play}>试听语音</button> : <p className="field-help">音频上传后，可在这里选择立直语音。</p>}
    {voice.error && <p className="warning-text" role="status">{voice.error}</p>}
  </section>;
}
