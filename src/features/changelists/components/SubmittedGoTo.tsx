import { useRef, useState } from "react";
import { ArrowRight, Hash } from "lucide-react";
import { parseChangeNumber } from "../submittedFilters";
import { useChangeDetails } from "./ChangeDetailsDialog";

export function SubmittedGoTo({ zh }: { zh: boolean }) {
  const open = useChangeDetails();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const label = zh ? "转到 CL" : "Go to CL";
  return (
    <form
      className="submitted-go-to diff-path-field"
      onSubmit={(event) => {
        event.preventDefault();
        const changeId = parseChangeNumber(value);
        setInvalid(changeId === undefined);
        if (changeId !== undefined)
          open?.({ kind: "submitted", changeId }, input.current);
      }}
    >
      <Hash size={15} aria-hidden="true" />
      <input
        className="target-path-input"
        aria-label={label}
        placeholder={label}
        ref={input}
        id="submitted-go-to"
        inputMode="numeric"
        value={value}
        aria-invalid={invalid}
        aria-describedby={invalid ? "submitted-go-to-hint" : undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
      />
      <span className="target-refresh-slot">
        <button
          type="submit"
          className="secondary"
          disabled={!open}
          title={label}
          aria-label={label}
        >
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </span>
      {invalid && (
        <small
          className="diff-path-error"
          id="submitted-go-to-hint"
          role="alert"
        >
          {zh
            ? "请输入有效的正整数 CL 号"
            : "Enter a positive integer changelist number"}
        </small>
      )}
    </form>
  );
}
