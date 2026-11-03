'use client';

import React from 'react';
import {
  MUSE_CONNECT_PROMPT,
  type AgentKey,
  type AgentKeyCreateResponse,
} from '@fbuploadpro/contracts';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Input } from '@/components/shared/ui/input';
import { StatusMark } from '@/components/shared/ui/status-mark';
import { toast } from '@/components/shared/ui/toast';
import {
  apiDelete,
  apiGet,
  apiPost,
  buildTenantApiPath,
  getErrorMessage,
} from '@/lib/api';
import {
  AgentKeyCreateResponseSchema,
  AgentKeyCreateSchema,
  AgentKeyListResponseSchema,
} from '@/lib/api/schemas/muse';

/**
 * Connect Muse dialogue — not a page section.
 *
 * Flow, in order: create a key, copy the prompt and give it to
 * Muse the first time, Muse asks for the key, then reads the
 * entire guide, then asks for FBUploadPro sign-in. The key
 * itself is never pasted in chat, and is shown exactly once
 * after creation.
 */
export function MuseConnectDialog({
  subdomain,
  open,
  onOpenChange,
}: Readonly<{
  subdomain: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const [keys, setKeys] = React.useState<AgentKey[]>([]);
  const [keysError, setKeysError] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [newKey, setNewKey] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [keyToRevoke, setKeyToRevoke] = React.useState<AgentKey | null>(null);
  const [revoking, setRevoking] = React.useState(false);

  const loadKeys = React.useCallback(async () => {
    try {
      const data = await apiGet(
        buildTenantApiPath(subdomain, '/muse/keys'),
        { schema: AgentKeyListResponseSchema }
      );
      setKeys(data.keys);
      setKeysError(null);
    } catch (error) {
      setKeysError(getErrorMessage(error));
    }
  }, [subdomain]);

  React.useEffect(() => {
    if (open) {
      void loadKeys();
    }
  }, [open, loadKeys]);

  async function copyText(text: string, doneMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(doneMessage);
    } catch {
      toast("Copy didn't work", {
        description: 'Select the text and copy it yourself.',
      });
    }
  }

  async function handleCreate() {
    const parsed = AgentKeyCreateSchema.safeParse({ name });
    if (!parsed.success) {
      toast('Please enter a name for the key.');
      return;
    }
    setCreating(true);
    try {
      const created: AgentKeyCreateResponse = await apiPost(
        buildTenantApiPath(subdomain, '/muse/keys'),
        { name: parsed.data.name },
        { schema: AgentKeyCreateResponseSchema }
      );
      setNewKey(created.key);
      setName('');
      await loadKeys();
    } catch {
      toast("We couldn't create the key. Try again.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    if (!keyToRevoke) return;
    setRevoking(true);
    try {
      await apiDelete(
        buildTenantApiPath(subdomain, `/muse/keys/${keyToRevoke.id}`)
      );
      // Revocation deletes the row: it is removed from the list,
      // never flipped to a Revoked row that stays behind.
      setKeys((current) => current.filter((key) => key.id !== keyToRevoke.id));
      setKeyToRevoke(null);
      toast('Key revoked and removed.');
    } catch {
      toast("We couldn't revoke the key. Try again.");
    } finally {
      setRevoking(false);
    }
  }

  const isKeysSetupMissing = keysError === 'Muse keys are not set up yet';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Muse</DialogTitle>
            <DialogDescription>
              Create a key so Muse can add media to your Media Library.
              You will only see the key once, so copy it straight away.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex gap-2">
              <Input
                aria-label="Key name"
                placeholder="For example: Home computer"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Button onClick={() => void handleCreate()} disabled={creating}>
                {creating ? 'Creating…' : 'Create key'}
              </Button>
            </div>
            <p className="text-ink-sub text-sm">
              Muse can only add media to, and view, your Media Library
              with this key. It cannot publish, schedule, change
              settings, or view billing.
            </p>

            {newKey ? (
              <div className="border-t border-line pt-4">
                <p className="font-medium">New key — shown once</p>
                <p className="mt-1 break-all font-mono text-sm">{newKey}</p>
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void copyText(newKey, 'Key copied.')}
                  >
                    Copy key
                  </Button>
                  <p className="text-ink-sub text-sm">
                    Copy it now. It will not be shown again. Give it to
                    Muse when Muse asks for it — do not paste it in
                    chat.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="border-t border-line pt-4">
              <p className="font-medium">Prompt for Muse</p>
              <p className="text-ink-sub text-sm">
                Copy this prompt and give it to Muse the first time.
                Muse will first ask for your key, then read the entire
                guide, then ask for your FBUploadPro sign-in.
              </p>
              <p className="mt-2 text-sm leading-relaxed">
                {MUSE_CONNECT_PROMPT}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  onClick={() =>
                    void copyText(MUSE_CONNECT_PROMPT, 'Prompt copied.')
                  }
                >
                  Copy prompt
                </Button>
                <p className="text-ink-sub text-sm">Then paste it into Muse.</p>
              </div>
            </div>

            <div className="border-t border-line pt-4">
              <p className="font-medium">Your keys</p>
              {keysError ? (
                <p className="text-ink-sub text-sm">
                  {isKeysSetupMissing
                    ? "Muse isn't set up for this workspace yet. Ask the workspace owner to finish setup, then try again."
                    : 'We couldn\'t load your keys. Close and reopen this dialog to try again.'}
                </p>
              ) : keys.length === 0 ? (
                <p className="text-ink-sub text-sm">
                  You haven&apos;t created a key yet. Create one above to
                  connect Muse.
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {keys.map((key) => (
                    <li
                      key={key.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-3"
                    >
                      <div>
                        <p className="font-medium">{key.name}</p>
                        <p className="font-mono text-sm text-ink-sub">
                          {key.keyPrefix}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <StatusMark
                          kind="operational"
                          label="Active"
                          testId={`muse-key-status-${key.id}`}
                        />
                        <Button
                          variant="destructive"
                          onClick={() => setKeyToRevoke(key)}
                        >
                          Revoke
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={keyToRevoke !== null}
        onOpenChange={(next) => {
          if (!next) setKeyToRevoke(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this key?</AlertDialogTitle>
            <AlertDialogDescription>
              Muse will immediately lose access to your Media Library
              through this key, and the key will be removed from this
              list. Media already added stays in your Media Library.
              To reconnect, create a new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleRevoke()}
              disabled={revoking}
            >
              {revoking ? 'Revoking…' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
