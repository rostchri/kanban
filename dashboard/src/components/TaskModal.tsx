import { useEffect } from 'react';
import { X, Bot, Hand, Calendar, Clock, Hash, Terminal } from 'lucide-react';
import { STATUS_COLORS, STATUS_LABELS } from '../types.ts';
import type { Task } from '../types.ts';
import { Tag } from './Tag.tsx';

interface TaskModalProps {
  task: Task;
  onClose: () => void;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function TaskModal({ task, onClose }: TaskModalProps) {
  const color = STATUS_COLORS[task.status];

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg bg-[var(--surface-1)] border border-[var(--border-default)] rounded-2xl shadow-[var(--shadow-lg)] overflow-hidden animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-[var(--border-subtle)]">
          <div className="flex-1 min-w-0 pr-4">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wide"
                style={{
                  backgroundColor: `${color}15`,
                  color: color,
                }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: color }}
                />
                {STATUS_LABELS[task.status]}
              </span>
            </div>
            <h2 className="text-base font-bold text-[var(--text-primary)] leading-snug">
              {task.title}
            </h2>
            <span className="text-[11px] text-[var(--text-muted)] font-mono mt-1 block">
              {task.id}
            </span>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
            aria-label="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5 max-h-[60vh] overflow-y-auto">
          {/* Description */}
          {task.description && (
            <div>
              <h3 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Description
              </h3>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                {task.description}
              </p>
            </div>
          )}

          {/* Notes */}
          {task.notes && task.notes.length > 0 && (
            <div>
              <h3 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Notes ({task.notes.length})
              </h3>
              <div className="space-y-2">
                {task.notes.map((note, index) => {
                  const match = note.match(/^\[(.+?)\]\s*(.+)$/);
                  const timestamp = match ? match[1] : '';
                  const content = match ? match[2] : note;
                  const meta = task.noteMeta?.[index] ?? null;

                  return (
                    <div
                      key={index}
                      className="flex gap-3 p-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border-subtle)]"
                    >
                      <span className="text-[11px] text-[var(--text-subtle)] font-mono shrink-0 pt-0.5">
                        {timestamp}
                      </span>
                      <span className="text-sm text-[var(--text-secondary)] leading-relaxed flex-1 min-w-0">
                        {content}
                      </span>
                      {(meta?.model || meta?.agent) && (
                        <span
                          className="text-[10px] text-[var(--text-subtle)] opacity-60 font-mono shrink-0 pt-0.5 text-right"
                          title={[meta?.agent && `agent: ${meta.agent}`, meta?.model && `model: ${meta.model}`].filter(Boolean).join('\n')}
                        >
                          {[meta?.model, meta?.agent && `(${meta.agent})`].filter(Boolean).join(' ')}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tags */}
          {task.tags.length > 0 && (
            <div>
              <h3 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Tags
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {task.tags.map((tag) => (
                  <Tag key={tag} label={tag} />
                ))}
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="pt-4 border-t border-[var(--border-subtle)]">
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <Calendar size={13} />
                <span>Created: {formatDate(task.createdAt)}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <Clock size={13} />
                <span>Updated: {formatDate(task.updatedAt)}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                {task.source === 'claude' ? (
                  <>
                    <Bot size={13} />
                    <span>Source: Claude</span>
                  </>
                ) : task.source === 'opencode' ? (
                  <>
                    <Terminal size={13} />
                    <span>Source: OpenCode</span>
                  </>
                ) : (
                  <>
                    <Hand size={13} />
                    <span>Source: Manual</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <Hash size={13} />
                <span>ID: {task.id}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
