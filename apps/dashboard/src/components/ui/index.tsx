"use client";

import Link from "next/link";
import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type LabelHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode
} from "react";
import { togglePasswordVisibility } from "../auth/login-form.logic";

function mergeClassNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", loading = false, disabled, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={mergeClassNames("ui-button", `ui-button--${variant}`, className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <span className="ui-spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
});

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={mergeClassNames("ui-input", className)} {...props} />;
  }
);

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={mergeClassNames("ui-label", className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <section className={mergeClassNames("ui-card", className)} {...props} />;
}

export function Badge({
  className,
  children,
  tone = "neutral"
}: Readonly<{
  className?: string;
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}>) {
  return (
    <span className={mergeClassNames("ui-badge", `ui-badge--${tone}`, className)}>{children}</span>
  );
}

export function Avatar({ name, className }: Readonly<{ name: string; className?: string }>) {
  const initials = useMemo(
    () =>
      name
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .slice(0, 2)
        .join("") || "A",
    [name]
  );
  return (
    <div className={mergeClassNames("ui-avatar", className)} aria-label={name}>
      {initials}
    </div>
  );
}

export function Skeleton({ className }: Readonly<{ className?: string }>) {
  return <div className={mergeClassNames("ui-skeleton", className)} aria-hidden="true" />;
}

export function Alert({
  className,
  tone = "neutral",
  title,
  children
}: Readonly<{
  className?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  title: string;
  children?: ReactNode;
}>) {
  return (
    <div className={mergeClassNames("ui-alert", `ui-alert--${tone}`, className)} role="alert">
      <strong>{title}</strong>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action
}: Readonly<{ title: string; description: string; action?: ReactNode }>) {
  return (
    <Card className="ui-empty">
      <h3>{title}</h3>
      <p>{description}</p>
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </Card>
  );
}

/** A single "go back to the page this one was reached from" link — used at the top of every nested/detail
 * page (a record opened from a list, a settings sub-page, etc.) so navigating one level up never depends
 * on the browser's own back button. `href` is always an explicit destination (never `router.back()`) so
 * the target is correct even when the page was opened directly (a bookmark, a shared link, a reload). */
export function BackLink({ href, label = "Back" }: Readonly<{ href: string; label?: string }>) {
  return (
    <Link href={href} className="back-link">
      ← {label}
    </Link>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
  backHref,
  backLabel
}: Readonly<{
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  backHref?: string;
  backLabel?: string;
}>) {
  return (
    <div className="ui-page-header">
      <div>
        {backHref ? <BackLink href={backHref} {...(backLabel ? { label: backLabel } : {})} /> : null}
        {eyebrow ? <p className="ui-page-header__eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="ui-page-header__description">{description}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export function SummaryCard({
  title,
  value,
  hint
}: Readonly<{ title: string; value: string | number; hint?: string }>) {
  return (
    <Card className="ui-summary-card">
      <p className="ui-summary-card__title">{title}</p>
      <div className="ui-summary-card__value">{value}</div>
      {hint ? <p className="ui-summary-card__hint">{hint}</p> : null}
    </Card>
  );
}

export function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoComplete = "current-password",
  placeholder,
  ariaInvalid,
  ariaDescribedBy
}: Readonly<{
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  autoComplete?: string;
  placeholder?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="ui-field">
      <Label htmlFor={id}>{label}</Label>
      <div className="ui-password">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          placeholder={placeholder}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          type="button"
          variant="ghost"
          className="ui-password__toggle"
          onClick={() => setVisible((current) => togglePasswordVisibility(current))}
          aria-label={visible ? "Hide password" : "Show password"}
        >
          {visible ? "Hide" : "Show"}
        </Button>
      </div>
    </div>
  );
}

export function Dialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  showActions = true,
  onConfirm,
  onCancel,
  children
}: Readonly<{
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  showActions?: boolean;
  onConfirm(): void | Promise<void>;
  onCancel(): void;
  children?: ReactNode;
}>) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open && typeof dialog.showModal === "function") {
      dialog.showModal();
    } else if (!open && dialog.open && typeof dialog.close === "function") {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="ui-dialog"
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="ui-dialog__panel">
        <h2 id="dialog-title">{title}</h2>
        {description ? <p>{description}</p> : null}
        {children}
        {showActions ? (
          <div className="ui-dialog__actions">
            <Button type="button" variant="secondary" onClick={onCancel}>
              {cancelLabel}
            </Button>
            <Button type="button" variant={destructive ? "danger" : "primary"} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}

export function DropdownMenu({
  trigger,
  triggerProps,
  children
}: Readonly<{
  trigger: ReactNode;
  triggerProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  children: ReactNode;
}>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [open]);

  return (
    <div className="ui-dropdown" ref={rootRef}>
      <button
        type="button"
        className="ui-dropdown__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        {...triggerProps}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger}
      </button>
      {open ? (
        <div className="ui-dropdown__panel" role="menu">
          {children}
        </div>
      ) : null}
    </div>
  );
}
