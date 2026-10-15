import { useEffect, useRef } from 'react';

export function useVoiceAudio() {
  const element = useRef(null);
  const graph = useRef(null);
  useEffect(() => () => {
    element.current?.pause();
    graph.current?.context.close();
  }, []);
  function setVolume(volume) {
    if (graph.current) graph.current.gain.gain.setTargetAtTime(volume / 100, graph.current.context.currentTime, 0.01);
  }
  function resume(volume) {
    if (!graph.current) {
      const context = new AudioContext(), gain = context.createGain();
      gain.gain.value = volume / 100;
      context.createMediaElementSource(element.current).connect(gain);
      gain.connect(context.destination);
      graph.current = { context, gain };
    }
    setVolume(volume);
    return graph.current.context.resume();
  }
  return { element, resume, setVolume };
}

export function VoicePreview({ src, volume, onError }) {
  const audio = useVoiceAudio();
  useEffect(() => { audio.setVolume(volume); }, [volume]);
  return <audio ref={audio.element} className="voice-preview" aria-label="试听立直音频" controls preload="metadata" src={src} onError={onError}
    onPlay={async () => { try { await audio.resume(volume); } catch { audio.element.current?.pause(); onError(); } }} />;
}
