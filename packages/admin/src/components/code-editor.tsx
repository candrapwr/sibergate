'use client';

import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';

/**
 * Lightweight JS code editor wrapper around @uiw/react-codemirror.
 *
 * Loaded via next/dynamic (ssr:false) from the page that uses it, because the
 * CodeMirror bundle touches `document`/`window` at import time and must not
 * run during SSR. The parent owns the value; this component is controlled.
 */
export function CodeEditor({
  value,
  onChange,
  minHeight = 360,
  readOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  minHeight?: number;
  readOnly?: boolean;
}) {
  const extensions = useMemo(() => [javascript({ jsx: false, typescript: false })], []);
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <CodeMirror
        value={value}
        height={String(minHeight)}
        minHeight={`${minHeight}px`}
        theme={oneDark}
        extensions={extensions}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          foldGutter: true,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true,
          indentOnInput: true,
        }}
        onChange={(v) => onChange(v)}
      />
    </div>
  );
}
