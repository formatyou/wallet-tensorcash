import { useEffect, useRef, useState, type ReactNode } from 'react';

interface ToastProps {
  message: string;
  tone: 'success' | 'error';
  dismissLabel: string;
  onDismiss: () => void;
  action?: ReactNode;
}

/** Action feedback only. Persistent network state and form errors stay inline. */
export function Toast({ message, tone, dismissLabel, onDismiss, action }: ToastProps) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const remaining = useRef(6_000);

  useEffect(() => {
    const visibilityChanged = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => document.removeEventListener('visibilitychange', visibilityChanged);
  }, []);

  useEffect(() => { remaining.current = 6_000; }, [message]);

  useEffect(() => {
    if (tone !== 'success' || hovered || focused || hidden) return;
    const started = Date.now();
    const timer = window.setTimeout(() => dismiss.current(), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [message, tone, hovered, focused, hidden]);

  return <div className={`wallet-toast message ${tone}`} data-testid="wallet-toast"
    onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }}
    onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <svg className="toast-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />{tone === 'success' ? <path d="m8 12 3 3 5-6" /> : <><path d="M12 7v6" /><circle cx="12" cy="17" r=".75" fill="currentColor" stroke="none" /></>}
    </svg>
    <div className="toast-body"><p className="toast-text" role={tone === 'error' ? 'alert' : 'status'} aria-atomic="true">{message}</p>{action && <div className="toast-action">{action}</div>}</div>
    <button className="toast-dismiss" type="button" aria-label={dismissLabel} onClick={onDismiss}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>
  </div>;
}
