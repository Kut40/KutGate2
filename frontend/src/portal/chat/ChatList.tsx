import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { ChatInfo } from './protocol';

function relTime(ts: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return 'şimdi';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} dk`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} sa`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} gün`;
  return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

export function ChatList({ chats, onOpen, onDelete }: { chats: ChatInfo[]; onOpen: (id: string) => void; onDelete: (chat: ChatInfo) => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <section className="kg-chats" aria-label="Sohbetler">
      <h2 className="kg-h">
        <span>Sohbetler</span>
        <span className="kg-h-count">{chats.length}</span>
      </h2>
      {chats.length === 0 ? (
        <p className="kg-note">Henüz sohbet yok</p>
      ) : (
        <ul className="kg-chatlist">
          {chats.map((c) => (
            <li key={c.id} className="kg-chatitem">
              <button type="button" className="kg-chatrow" aria-current={c.active ? 'true' : undefined} title={c.title} onClick={() => onOpen(c.id)}>
                <span className="kg-chatrow-title">{c.title}</span>
                <span className="kg-chatrow-time">{relTime(c.updated, now)}</span>
              </button>
              <button type="button" className="kg-chatdel" aria-label={`Sohbeti sil: ${c.title}`} onClick={() => onDelete(c)}>
                <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
