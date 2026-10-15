import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, LoaderCircle } from 'lucide-react';
import { api } from './api';

export function AdminVoices() {
  const [items, setItems] = useState(null);
  const [editing, setEditing] = useState(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    api('/riichi-voices', { signal: abort.signal }).then(setItems).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [revision]);
  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  function edit(item) { setEditing(item); setFile(null); setDeleting(false); setError(''); setNotice(''); }
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (editing.id) await api(`/admin/riichi-voices/${editing.id}`, { method: deleting ? 'DELETE' : 'POST', ...(!deleting ? { body: { name: editing.name } } : {}) });
      else {
        const format = file?.name.split('.').pop().toLowerCase();
        if (!file || !['mp3', 'wav', 'ogg', 'm4a', 'aac'].includes(format)) throw new Error('请选择 MP3、WAV、OGG、M4A 或 AAC 文件');
        if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('音频不能为空，且不能超过 5 MB');
        await api(`/admin/riichi-voices?${new URLSearchParams({ name: editing.name, format })}`, { method: 'POST', body: file });
      }
      setNotice(deleting ? '音频已删除' : editing.id ? '名称已保存' : '音频已上传，玩家可在牌桌设置中选择');
      setEditing(null); setFile(null); setDeleting(false); setRevision((n) => n + 1);
      window.dispatchEvent(new Event('dianque:voices-changed'));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <section>
    {notice && <p className="field-help" role="status">{notice}</p>}
    {error && <p className="warning-text" role="alert">{error}</p>}
    {editing ? <>
      <button className="text-button" disabled={busy} onClick={() => edit(null)}><ArrowLeft size={17} />音频列表</button>
      <form className="admin-section" onSubmit={save}><fieldset className="admin-fields" disabled={busy}>
        {deleting ? <div className="admin-confirm"><p>删除「{editing.name}」？删除后所有玩家都无法再选择或播放这段语音。</p><div className="panel-actions"><button type="button" className="button" onClick={() => setDeleting(false)}>保留音频</button><button className="button danger">确认删除音频</button></div></div> : <>
          {!editing.id && <><label>音频文件<input type="file" accept=".mp3,.wav,.ogg,.m4a,.aac" required onChange={(e) => { const selected = e.target.files[0] || null; setFile(selected); setError(''); if (selected) setEditing({ name: selected.name.replace(/\.[^.]+$/, '').slice(0, 60) }); }} /></label><p className="field-help">支持 MP3、WAV、OGG、M4A、AAC，单个文件不超过 5 MB。</p></>}
          <label>音频名称<input required maxLength={60} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
          {(editing.url || preview) && <audio key={editing.url || preview} className="voice-preview" aria-label="试听立直音频" controls preload="metadata" src={editing.url || preview} onError={() => setError('无法播放这段音频，请检查文件和浏览器支持的格式')} />}
          <button className="button primary full" disabled={busy || (!editing.id && !file)}>{busy && <LoaderCircle size={18} className="spin" />}{busy ? '正在保存…' : editing.id ? '保存名称' : '上传音频'}</button>
          {editing.id && <button type="button" className="text-button danger-text voice-delete" onClick={() => setDeleting(true)}>删除音频</button>}
        </>}
      </fieldset></form>
    </> : <>
      <div className="account-heading"><strong>立直音频</strong><button className="text-button" onClick={() => edit({ name: '' })}>上传音频</button></div>
      <p className="field-help">上传后供所有玩家选择。点击音频可试听、改名或删除。</p>
      <div className="session-list">{items?.map((item) => <button key={item.id} onClick={() => edit(item)}><span><b>{item.name}</b><small>{(item.size / 1024 / 1024).toFixed(2)} MB</small></span><ChevronRight size={20} /></button>)}</div>
      {items?.length === 0 && <p className="empty">暂无立直音频</p>}{!items && !error && <p role="status">正在读取音频…</p>}
      {error && <button className="text-button" onClick={() => { setError(''); setRevision((n) => n + 1); }}>重试</button>}
    </>}
  </section>;
}
