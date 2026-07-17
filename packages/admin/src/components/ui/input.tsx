import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Admin inputs are operator-entered config (API keys, URLs, ids), never saved
 * logins — so we suppress browser autofill/password-manager autocomplete by
 * default. Override per-field if a specific autocomplete is genuinely wanted.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, autoComplete, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      // Chrome ignores autoComplete="off" for password fields; "new-password"
      // is the reliable signal that this is NOT a login form. The data-* attrs
      // tell common password managers (LastPass, 1Password, Dashlane) to skip.
      autoComplete={autoComplete ?? (type === 'password' ? 'new-password' : 'off')}
      data-lpignore="true"
      data-1p-ignore="true"
      data-form-type="other"
      className={cn(
        'flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-[13px] shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
