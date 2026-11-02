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
 * Muse, Muse asks for the key with its FBUploadPro connector,
 * then reads the entire guide, then asks for login via secure
 * store. The key itself goes in the connector, never in chat,
 * and is shown exactly once after creation.
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
      toast('Copy failed', {
        description: 'Select the text and copy it manually.',
      });
    }
  }

  async function handleCreate() {
    const parsed = AgentKeyCreateSchema.safeParse({ name });
    if (!parsed.success) {
      toast('Enter a key name.');
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
    } catch (error) {
      toast('Could not create the key', { description: getErrorMessage(error) });
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
    } catch (error) {
      toast('Could not revoke the key', { description: getErrorMessage(error) });
    } finally {
      setRevoking(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Muse</DialogTitle>
            <DialogDescription>
              Create a key for Muse to use your Media Library.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex gap-2">
              <Input
                aria-label="Key name"
                placeholder="Key name, e.g. My Muse"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Button onClick={() => void handleCreate()} disabled={creating}>
                {creating ? 'Creating…' : 'Create key'}
              </Button>
            </div>
            <p className="text-ink-sub text-sm">
              <strong className="text-ink">Scope:</strong> Media Library,
              read and write only.
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
                    Copy it now. It will not be shown again.
                  </p>
                </div>
              </div>
            ) : null}

            <div className="border-t border-line pt-4">
              <p className="font-medium">Prompt for Muse</p>
              <p className="text-ink-sub text-sm">
                Copy this prompt and give it to Muse. Muse will first
                ask for your key with its FBUploadPro connector, then
                read the entire guide, then ask for your login via
                secure store.
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
              <p className="text-ink-sub mt-2 text-sm">
                Next, in order: 1. Muse asks for your key with its
                FBUploadPro connector. 2. Muse reads the entire guide
                at the link in the prompt. 3. Muse asks for your login
                via secure store. Put your key in the connector — not
                in the chat.
              </p>
            </div>

            <div className="border-t border-line pt-4">
              <p className="font-medium">Your keys</p>
              {keysError ? (
                <p className="text-ink-sub text-sm">{keysError}</p>
              ) : keys.length === 0 ? (
                <p className="text-ink-sub text-sm">No keys yet.</p>
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
              Muse will lose Media Library access with this key
              immediately, and the key will be removed from this list.
              You will need to create a new key to reconnect.
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
