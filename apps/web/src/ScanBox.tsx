import { type FormEvent, useEffect, useRef, useState } from "react";

/**
 * A text box that keyboard-wedge scanners type into. A scan ends with Enter,
 * which submits it. The box keeps focus so the next scan lands here too, and
 * takes it back when a scan starts while a button has it (after a tap on +).
 */
export function ScanBox(props: { label: string; disabled?: boolean; onScan: (code: string) => void }) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.disabled) input.current?.focus();
  }, [props.disabled]);

  useEffect(() => {
    const reclaim = (event: KeyboardEvent) => {
      const active = document.activeElement;
      if (props.disabled || event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      input.current?.focus();
    };
    document.addEventListener("keydown", reclaim, true);
    return () => document.removeEventListener("keydown", reclaim, true);
  }, [props.disabled]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const code = value.trim();
    setValue("");
    if (code) props.onScan(code);
    input.current?.focus();
  };

  return (
    <form className="scan" onSubmit={submit}>
      <label htmlFor="scan">{props.label}</label>
      <input
        id="scan"
        ref={input}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={props.disabled}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="go"
      />
    </form>
  );
}
