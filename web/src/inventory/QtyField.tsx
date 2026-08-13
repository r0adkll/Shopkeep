import { useEffect, useState } from "react";
import { Field } from "../ui";
import { formatQty, parseQtyAs } from "./api";

/** Field for a quantity in a material's unit, string-buffered so decimals and
 *  unit suffixes type naturally: when the unit is grams, "3oz" commits as
 *  85.05 g. Text snaps to the committed (converted) value on blur. */
export function QtyField({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? "" : formatQty(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value == null ? "" : formatQty(value));
  }, [value, focused]);
  return (
    <Field
      label={label}
      value={text}
      onChange={(v) => {
        setText(v);
        onChange(v.trim() === "" ? null : parseQtyAs(unit, v));
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    />
  );
}
