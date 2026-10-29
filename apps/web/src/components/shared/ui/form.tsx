"use client";

/**
 * Form primitives — THE form standard (spec 137 §3.8, decision D137-5).
 *
 * One pattern for every form in the product, built here so a surface
 * cannot get it wrong:
 *
 * - **Stack**: `react-hook-form` + the zod resolver (`@hookform/resolvers/zod`).
 *   Form schemas are zod schemas living beside the form — or in
 *   `lib/api/schemas` where the form *is* an API payload (reuse the
 *   payload schema; never duplicate it).
 * - **Wiring**: `Form` (the RHF provider) → `FormField` per field →
 *   `FormItem` → `FormLabel` / `FormControl` (wraps the shared/ui
 *   control) / `FormDescription` (the always-visible hint) /
 *   `FormMessage` (the inline error). `FormControl` wires the control's
 *   `id`, `aria-describedby` (hint + error) and `aria-invalid` from the
 *   field state — consumers never hand-wire ARIA.
 * - **Validation mode**: `mode: "onTouched"` — validate on blur; after
 *   a submit attempt RHF re-validates on change. Real-time validation
 *   only for unambiguous formats (character counts, availability).
 * - **Error pattern** (UI Rule 4 / UX Rule 23): on submit failure, focus
 *   moves to the `FormErrorSummary` (`role="alert"`); each summary entry
 *   is an anchor link to its field and its wording matches the inline
 *   `FormMessage` exactly; the inline message sits under its field and
 *   states the fix; **user input is never cleared** by a failed submit.
 * - **Submit state**: the submit button is the shared/ui `Button` with
 *   its `loading` state driven by `formState.isSubmitting` (disabled
 *   while pending); success/failure present via the interruption ladder
 *   (inline → summary → banner), never silently.
 *
 * Proven by the reference implementation: the login form
 * (`src/app/login/`) — spec 136 inherits it for the remaining auth
 * forms, and every surface adopts this standard in its rebuild
 * (spec 137 §4.1).
 *
 * The non-RHF `Field` wrapper below (129-F3) stays for simple
 * controlled fields that do not warrant a form schema; new multi-field
 * forms use the RHF pattern above.
 */
import * as React from "react";
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from "react-hook-form";
import { Label as LabelPrimitive, Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* react-hook-form pattern (shadcn Form base, adapted to our tokens)   */
/* ------------------------------------------------------------------ */

const Form = FormProvider;

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
  name: TName;
};

const FormFieldContext = React.createContext<FormFieldContextValue | null>(null);

type FormItemContextValue = {
  id: string;
};

const FormItemContext = React.createContext<FormItemContextValue | null>(null);

function FormField<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({ ...props }: ControllerProps<TFieldValues, TName>) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

/** Field state + the ARIA ids for one field, from the surrounding contexts. */
function useFormField() {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState } = useFormContext();
  const formState = useFormState(fieldContext ? { name: fieldContext.name } : undefined);

  if (!fieldContext) {
    throw new Error("useFormField must be used within a FormField");
  }
  if (!itemContext) {
    throw new Error("useFormField must be used within a FormItem");
  }

  const fieldState = getFieldState(fieldContext.name, formState);
  const { id } = itemContext;

  return {
    id,
    name: fieldContext.name,
    formItemId: id,
    formDescriptionId: `${id}-description`,
    formMessageId: `${id}-message`,
    ...fieldState,
  };
}

type FormItemProps = React.ComponentProps<"div"> & {
  /** Explicit control id (stable anchors / e2e). Defaults to a generated id. */
  id?: string;
};

function FormItem({ id: idProp, className, ...props }: FormItemProps) {
  const generatedId = React.useId();
  const id = idProp ?? generatedId;
  return (
    <FormItemContext.Provider value={{ id }}>
      <div data-slot="form-item" className={cn("flex flex-col gap-1.5", className)} {...props} />
    </FormItemContext.Provider>
  );
}

function FormLabel({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  const { error, formItemId } = useFormField();
  return (
    <LabelPrimitive.Root
      data-slot="form-label"
      data-error={!!error}
      className={cn("text-body font-medium text-ink", className)}
      htmlFor={formItemId}
      {...props}
    />
  );
}

function FormControl({ ...props }: React.ComponentProps<typeof Slot.Root>) {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField();
  return (
    <Slot.Root
      data-slot="form-control"
      id={formItemId}
      aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
      aria-invalid={!!error}
      {...props}
    />
  );
}

function FormDescription({ className, ...props }: React.ComponentProps<"p">) {
  const { formDescriptionId } = useFormField();
  return (
    <p
      data-slot="form-description"
      id={formDescriptionId}
      className={cn("text-metadata text-ink-sub", className)}
      {...props}
    />
  );
}

function FormMessage({ className, children, ...props }: React.ComponentProps<"p">) {
  const { error, formMessageId } = useFormField();
  const body = error ? String(error.message ?? "") : children;
  if (!body) return null;
  return (
    <p
      data-slot="form-message"
      id={formMessageId}
      role={error ? "alert" : undefined}
      className={cn("text-metadata font-medium text-signal-critical", className)}
      {...props}
    >
      {body}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Field — the F3 controlled-field wrapper (non-RHF convenience)       */
/* ------------------------------------------------------------------ */

type FieldProps = {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  className?: string;
  children: React.ReactElement<{
    id?: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }>;
};

function Field({ id, label, hint, error, optional, className, children }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const controlProps: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean } = { id };
  if (describedBy) controlProps["aria-describedby"] = describedBy;
  if (error) controlProps["aria-invalid"] = true;
  const control = React.cloneElement(children, controlProps);
  return (
    <div data-slot="field" className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-body font-medium text-ink">
        {label}
        {optional ? <span className="text-ink-dim"> (optional)</span> : null}
      </label>
      {hint ? (
        <p id={hintId} className="text-metadata text-ink-sub">
          {hint}
        </p>
      ) : null}
      {control}
      {error ? (
        <p id={errorId} role="alert" className="text-metadata font-medium text-signal-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* FormErrorSummary — built new (shadcn has no equivalent)             */
/* ------------------------------------------------------------------ */

export interface FormErrorSummaryEntry {
  /** Control id the entry links to. Omit for form-level (submit) errors. */
  fieldId?: string;
  /** Wording identical to the field's inline message. */
  message: string;
}

type FormErrorSummaryProps = React.ComponentProps<"div"> & {
  errors: FormErrorSummaryEntry[];
  title?: string;
};

/**
 * The submit-failure summary box (spec §3.8). Render it only once a
 * submit has been attempted (or a submit-level server error exists) —
 * field-level blur errors stay inline until then.
 *
 * Focus: when the summary's error set first appears (or is replaced
 * while focus is on the submit control / nowhere in a field), focus
 * moves to the summary. It never steals focus from a field the user is
 * typing in. Entries are anchor links to their fields, wording
 * identical to the inline messages; form-level errors (no `fieldId`)
 * render as plain entries.
 */
const FormErrorSummary = React.forwardRef<HTMLDivElement, FormErrorSummaryProps>(
  function FormErrorSummary({ errors, title = "Check the form", className, ...props }, ref) {
    const innerRef = React.useRef<HTMLDivElement | null>(null);
    const signature = errors.map((e) => `${e.fieldId ?? ""}:${e.message}`).join("|");
    const lastFocusedSignature = React.useRef<string | null>(null);

    React.useEffect(() => {
      if (errors.length === 0) {
        lastFocusedSignature.current = null;
        return;
      }
      if (lastFocusedSignature.current === signature) return;
      const active = document.activeElement;
      const focusIsInField =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement;
      lastFocusedSignature.current = signature;
      if (!focusIsInField) {
        innerRef.current?.focus();
      }
    }, [errors.length, signature]);

    if (errors.length === 0) return null;
    return (
      <div
        ref={(node) => {
          innerRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        tabIndex={-1}
        role="alert"
        data-slot="form-error-summary"
        className={cn(
          "rounded-md border border-signal-critical bg-panel px-4 py-3 text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal-critical",
          className
        )}
        {...props}
      >
        <p className="font-medium text-signal-critical">{title}</p>
        <ul className="mt-1 list-inside list-disc">
          {errors.map((e, index) => (
            <li key={e.fieldId ?? `form-level-${index}`}>
              {e.fieldId ? (
                <a href={`#${e.fieldId}`} className="underline underline-offset-4 hover:text-signal-critical">
                  {e.message}
                </a>
              ) : (
                <span>{e.message}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }
);

export {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
  FormMessage,
  useFormField,
  Field,
  FormErrorSummary,
};
export type { FieldProps, FormErrorSummaryProps };
