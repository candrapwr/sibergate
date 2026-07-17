'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/**
 * Reusable confirmation dialog.
 *
 * Wraps a trigger element (usually a delete icon button) in a two-step
 * confirm flow: the user clicks the trigger, a dialog opens asking them to
 * confirm, and only then does `onConfirm` fire. Used for every destructive
 * action (delete provider/model/route/api-key/user) so none of them can fire
 * on an accidental click.
 *
 * The trigger stays as-is via `asChild`; only its `open` state is controlled.
 * If `onConfirm` throws, the error is the caller's responsibility — wrap your
 * mutation in `.catch(...)` to show a toast (same as before).
 */
export interface ConfirmDialogProps {
  /** Element that opens the dialog (rendered inside a DialogTrigger asChild). */
  trigger: ReactNode;
  /** Dialog title, e.g. "Delete provider?". */
  title: string;
  /** Longer explanation shown under the title. */
  description: string;
  /** Label on the destructive confirm button. Defaults to "Delete". */
  confirmLabel?: string;
  /** Called when the user confirms. Await it to keep the button disabled while pending. */
  onConfirm: () => unknown | Promise<unknown>;
  /** Disable the confirm button (e.g. while a mutation is in flight). */
  pending?: boolean;
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = 'Delete',
  onConfirm,
  pending = false,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);

  const handleConfirm = async () => {
    try {
      await onConfirm();
      setOpen(false);
    } catch {
      // Surface errors via the caller's .catch on the mutation; keep the dialog
      // open so the user sees the failure toast without re-triggering.
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={pending}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
