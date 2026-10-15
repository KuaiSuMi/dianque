import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import './vendor/liquid-glass.js';

export const spring = { type: 'spring', duration: 0.45, bounce: 0.12 };

export function Expanding({ children, className = '', initial = true }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(null);
  const present = useIsPresent();
  const reduce = useReducedMotion();
  useLayoutEffect(() => {
    const measure = () => setHeight(ref.current.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <motion.div className="expanding" inert={!present}
    initial={initial && { height: reduce ? 'auto' : 0, opacity: 0 }}
    animate={{ height: height ?? 'auto', opacity: 1 }}
    exit={{ height: reduce ? height : 0, opacity: 0 }}
    transition={{ height: { duration: reduce ? 0 : 0.2, ease: [0.23, 1, 0.32, 1] }, opacity: { duration: reduce ? 0.1 : 0.16 } }}>
    <div ref={ref} className={`expanding-content ${className}`}>{children}</div>
  </motion.div>;
}

function Panel({ children, focusOnMount }) {
  const ref = useRef(null);
  const present = useIsPresent();
  const reduce = useReducedMotion();
  useLayoutEffect(() => {
    if (focusOnMount && (document.activeElement === document.body || document.activeElement?.closest('[inert]'))) ref.current.focus();
  }, []);
  return <motion.div ref={ref} className="panel-transition" tabIndex={-1} inert={!present}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
    transition={{ duration: reduce ? 0.08 : 0.14, ease: [0.23, 1, 0.32, 1] }}>{children}</motion.div>;
}

export function PanelTransition({ view, children }) {
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; }, []);
  return <AnimatePresence initial={false} mode="wait"><Panel key={view} focusOnMount={mounted.current}>{children}</Panel></AnimatePresence>;
}

export function PageTransition({ children }) {
  const reduce = useReducedMotion();
  const present = useIsPresent();
  useLayoutEffect(() => { window.scrollTo(0, 0); }, []);
  return <motion.div className="page-transition" inert={!present}
    initial={{ opacity: 0 }} animate={{ opacity: 1 }}
    exit={{ opacity: 0, transition: { duration: 0.1 } }}
    transition={{ duration: reduce ? 0.1 : 0.2 }}>{children}</motion.div>;
}

export function Segmented({ label, value, onChange, options, className = '' }) {
  const ref = useRef(null);
  const handler = useRef(onChange);
  handler.current = onChange;
  useLayoutEffect(() => {
    const el = ref.current;
    window.LiquidGlass.segmented(el);
    const change = () => handler.current(el.querySelector('.is-selected').dataset.value);
    el.addEventListener('change', change);
    return () => el.removeEventListener('change', change);
  }, []);
  return <div ref={ref} className={`as-segmented ${className}`} role="radiogroup" aria-label={label}>
    {options.map(([key, text]) => <button key={key} type="button" className={`as-segment ${value === key ? 'is-selected' : ''}`} role="radio" aria-checked={value === key} tabIndex={value === key ? 0 : -1} data-value={key}>{text}</button>)}
  </div>;
}

export function Toggle({ label, checked, disabled, onChange }) {
  const ref = useRef(null);
  const handler = useRef(onChange);
  const value = useRef(checked);
  value.current = checked;
  handler.current = (next) => { if (!disabled) onChange(next); };
  useEffect(() => {
    const el = ref.current;
    window.LiquidGlass.toggle(el);
    const change = () => {
      const next = el.getAttribute('aria-checked') === 'true';
      // 保存失败时仍显示 React 中的已保存状态。
      el.setAttribute('aria-checked', String(value.current));
      handler.current(next);
    };
    el.addEventListener('change', change);
    return () => el.removeEventListener('change', change);
  }, []);
  return <button ref={ref} type="button" className="as-toggle" role="switch" aria-label={label} aria-checked={checked} disabled={disabled}><span className="as-knob" /></button>;
}
