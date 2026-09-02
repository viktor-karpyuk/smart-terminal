import { useEffect, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  StreamLanguage,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { useStore } from '../state/store';

/**
 * The editing surface.
 *
 * CodeMirror rather than a textarea: selection, undo, search and a cursor that
 * behaves are not things worth reimplementing, and the app already carries xterm
 * for the same reason on the terminal side.
 *
 * The component owns the view and keeps it alive across renders — a code editor
 * that is torn down and rebuilt loses the scroll position, the selection and the
 * undo history, which is most of what makes it feel like an editor.
 */

/** The app's own palette, so a file reads like part of the window and not like a guest. */
const theme = EditorView.theme(
  {
    '&': { color: 'var(--text)', backgroundColor: 'var(--bg)', height: '100%' },
    '.cm-content': {
      caretColor: 'var(--accent)',
      fontFamily: 'var(--editor-font, "JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace)',
      fontSize: 'var(--editor-size, 12.5px)',
      padding: '8px 0',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(122, 162, 247, 0.22)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--bg)',
      color: '#3d4459',
      border: 'none',
      paddingRight: '4px',
    },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
    '.cm-activeLine': { backgroundColor: 'rgba(122, 162, 247, 0.05)' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(122, 162, 247, 0.16)' },
    '.cm-searchMatch': { backgroundColor: 'rgba(224, 175, 104, 0.24)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(224, 175, 104, 0.42)' },
    '.cm-scroller': { overflow: 'auto', lineHeight: '1.6' },
    '.cm-panels': { backgroundColor: 'var(--bg-panel)', color: 'var(--text)' },
    '.cm-panels input': { fontSize: '12px' },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: '#bb9af7' },
  { tag: [tags.string, tags.special(tags.string)], color: '#9ece6a' },
  { tag: [tags.comment, tags.blockComment, tags.lineComment], color: '#565f79', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#7aa2f7' },
  { tag: [tags.number, tags.bool, tags.null], color: '#ff9e64' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: '#2ac3de' },
  { tag: [tags.propertyName, tags.attributeName], color: '#7dcfff' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: '#7b849c' },
  { tag: [tags.heading], color: '#7aa2f7', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: '#7dcfff', textDecoration: 'underline' },
  { tag: [tags.invalid], color: '#f7768e' },
]);

/** Enough languages to cover what is actually in these repositories. */
function languageFor(path: string): Extension[] {
  const name = path.toLowerCase();
  const ext = name.slice(name.lastIndexOf('.') + 1);
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts'].includes(ext)) {
    return [javascript({ typescript: ext.startsWith('t'), jsx: ext.endsWith('x') })];
  }
  if (['css', 'scss', 'less'].includes(ext)) return [css()];
  if (['json', 'jsonc'].includes(ext) || name.endsWith('.json')) return [json()];
  if (['md', 'markdown', 'mdx'].includes(ext)) return [markdown()];
  if (['html', 'htm', 'vue', 'svelte'].includes(ext)) return [html()];
  if (['py', 'pyi'].includes(ext)) return [python()];
  if (['sql'].includes(ext)) return [sql()];
  // Shell, config and everything else: no grammar, but still an editor.
  if (['sh', 'zsh', 'bash', 'env', 'conf', 'ini', 'toml', 'yaml', 'yml'].includes(ext)) {
    return [StreamLanguage.define(simpleShell)];
  }
  return [];
}

/** A deliberately small grammar: comments and quotes are most of what helps here. */
const simpleShell = {
  token(stream: { eatSpace(): boolean; skipToEnd(): void; next(): string | void; match(re: RegExp): unknown; eol(): boolean; peek(): string | void }) {
    if (stream.eatSpace()) return null;
    const ch = stream.next();
    if (ch === '#') {
      stream.skipToEnd();
      return 'comment';
    }
    if (ch === '"' || ch === "'") {
      while (!stream.eol()) if (stream.next() === ch) break;
      return 'string';
    }
    return null;
  },
};

interface Props {
  path: string;
  /** Called on ⌘S and on Ctrl+S — both, deliberately. */
  onSave(): void;
  onSelection(from: number, to: number, text: string): void;
}

export function Editor({ path, onSave, onSelection }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Held in refs so the extensions built once can still reach the latest handler
  // without rebuilding the editor — rebuilding costs the undo history.
  const saveRef = useRef(onSave);
  const selectionRef = useRef(onSelection);
  saveRef.current = onSave;
  selectionRef.current = onSelection;

  const text = useStore((s) => s.buffers[path]?.text ?? '');
  const readOnly = useStore((s) => s.buffers[path]?.readOnly ?? false);
  const editBuffer = useStore((s) => s.editBuffer);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: useStore.getState().buffers[path]?.text ?? '',
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          indentOnInput(),
          bracketMatching(),
          highlightSelectionMatches(),
          syntaxHighlighting(highlight),
          theme,
          ...languageFor(path),
          /*
           * Both chords save. ⌘S is what macOS means, and Ctrl+S is what fingers
           * that have used every other editor mean — refusing the second one to
           * be correct about the platform would only ever be an obstacle.
           */
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => (saveRef.current(), true) },
            { key: 'Ctrl-s', preventDefault: true, run: () => (saveRef.current(), true) },
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              useStore.getState().editBuffer(path, update.state.doc.toString());
            }
            if (update.selectionSet) {
              const { from, to } = update.state.selection.main;
              selectionRef.current(
                update.state.doc.lineAt(from).number,
                update.state.doc.lineAt(to).number,
                update.state.sliceDoc(from, to),
              );
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Rebuilt only when the file changes — never on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, readOnly]);

  /*
   * Text that arrived from somewhere other than typing — a session rewriting the
   * file, or a revert. Written into the document only when it genuinely differs,
   * or every keystroke would be echoed back into the editor it came from.
   */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === text) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: text },
      // Keep the caret where it was when the new text is long enough to hold it.
      selection: { anchor: Math.min(view.state.selection.main.anchor, text.length) },
    });
  }, [text]);

  void editBuffer;
  return <div className="editor-host" ref={hostRef} />;
}
