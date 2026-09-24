import { useEffect, useRef } from 'react';
import { useT } from '../i18n';

export function ScriptPanel({
  text,
  editing,
  canCollapse,
  onTextChange,
  onEdit,
  onDone,
  onCollapse,
}: {
  text: string;
  editing: boolean;
  canCollapse: boolean;
  onTextChange: (text: string) => void;
  onEdit: () => void;
  onDone: () => void;
  onCollapse: () => void;
}) {
  const t = useT();
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  return (
    <section className="pane pane-script">
      <header className="pane-head script-head">
        <span className="pane-title">{t.script.title}</span>
        <button className="btn btn-sm" onClick={editing ? onDone : onEdit}>
          {editing ? t.script.done : t.script.edit}
        </button>
        <button
          className="btn btn-sm pane-collapse"
          onClick={onCollapse}
          disabled={!canCollapse}
          title={canCollapse ? t.layout.collapse(t.script.title) : t.layout.keepOneOpen}
          aria-label={t.layout.collapse(t.script.title)}
        >
          ‹
        </button>
      </header>
      {editing ? (
        <textarea
          ref={editorRef}
          className="script-editor"
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={t.script.placeholder}
          aria-label={t.script.editorLabel}
          spellCheck={false}
        />
      ) : (
        <div className="script-reader">
          {text || <span className="script-empty">{t.script.empty}</span>}
        </div>
      )}
    </section>
  );
}
