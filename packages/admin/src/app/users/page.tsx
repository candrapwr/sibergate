'use client';

import { useState } from 'react';
import { Plus, Trash2, Pencil, Users as UsersIcon, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useUsers, useCreateUser, useUpdateUser, useDeleteUser } from '@/lib/queries';
import { useUser } from '@/lib/auth-client';
import type { User } from '@/lib/types';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pagination } from '@/components/pagination';
import { StatusFilter } from '@/components/status-filter';
import { formatTs } from '@/lib/utils';

const ROLES = ['owner', 'admin', 'viewer'] as const;

export default function UsersPage() {
  const { data, isLoading } = useUsers();
  const { data: me } = useUser();
  const allUsers = data?.data ?? [];
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  // Users use a `status` field ('active' | 'disabled') rather than a boolean.
  // Map the shared filter vocabulary: enabled = active.
  const users = statusFilter === 'all'
    ? allUsers
    : allUsers.filter((u) => (statusFilter === 'enabled' ? u.status === 'active' : u.status === 'disabled'));
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const paged = users.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <div className="space-y-6">
      <PageHeader title="Users" subtitle="Admin panel access" actions={<CreateButton />} />
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-12 animate-pulse rounded-md bg-secondary/40" />)}</div>
      ) : allUsers.length === 0 ? (
        <EmptyState icon={UsersIcon} title="No users yet" hint="Create one to grant admin panel access." />
      ) : (
        <>
        <StatusFilter value={statusFilter} onChange={(v) => { setStatusFilter(v); setPage(0); }} />
        {users.length === 0 ? (
          <EmptyState icon={UsersIcon} title="No users match" hint={`No ${statusFilter} users. Switch the filter.`} />
        ) : (
        <>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last login</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((u) => (
              <UserRow key={u.id} user={u} selfId={me?.id} />
            ))}
          </TableBody>
        </Table>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={users.length}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
          itemName="users"
        />
        </>
        )}
        </>
      )}
    </div>
  );
}

function UserRow({ user, selfId }: { user: User; selfId?: string }) {
  const toggle = useUpdateUser();
  const del = useDeleteUser();
  const isSelf = user.id === selfId;

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-[11px] font-semibold text-primary">
            {(user.name || user.email).slice(0, 1).toUpperCase()}
          </div>
          <span>{user.name}</span>
          {isSelf && <Badge variant="muted" className="text-[10px]">you</Badge>}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{user.email}</TableCell>
      <TableCell><Badge variant={user.role === 'owner' ? 'default' : 'outline'}>{user.role}</Badge></TableCell>
      <TableCell>
        <button
          onClick={() => !isSelf && toggle.mutate({ id: user.id, data: { status: user.status === 'active' ? 'disabled' : 'active' } })}
          title={isSelf ? "Can't disable yourself" : user.status === 'active' ? 'Click to disable' : 'Click to enable'}
          disabled={isSelf}
        >
          <Badge variant={user.status === 'active' ? 'success' : 'muted'}>
            {user.status === 'active' ? <ShieldCheck size={11} className="mr-1 inline" /> : <ShieldOff size={11} className="mr-1 inline" />}
            {user.status}
          </Badge>
        </button>
      </TableCell>
      <TableCell className="text-muted-foreground">{formatTs(user.lastLoginAt)}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <EditButton user={user} />
          {!isSelf && (
            <ConfirmDialog
              trigger={
                <Button variant="ghost" size="icon">
                  <Trash2 size={14} className="text-muted-foreground hover:text-destructive" />
                </Button>
              }
              title={`Delete user "${user.email}"?`}
              description="This permanently removes the user's login. They will be signed out immediately and can no longer access the admin panel."
              pending={del.isPending}
              onConfirm={() =>
                del
                  .mutateAsync(user.id)
                  .then(() => toast.success('User deleted'))
                  .catch((e) => toast.error(e.message))
              }
            />
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function CreateButton() {
  const [open, setOpen] = useState(false);
  const create = useCreateUser();
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'admin' });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync({ ...form });
      toast.success('User created');
      setForm({ email: '', name: '', password: '', role: 'admin' });
      setOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus size={14} /> Add user</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Add user</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3" autoComplete="off">
          <div className="space-y-1.5">
            <Label htmlFor="uname">Name</Label>
            <Input id="uname" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="uemail">Email</Label>
            <Input id="uemail" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@example.com" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="upass">Password</Label>
            <Input id="upass" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="urole">Role</Label>
            <select id="urole" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]">
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <DialogFooter><Button type="submit" disabled={create.isPending}>Create</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditButton({ user }: { user: User }) {
  const [open, setOpen] = useState(false);
  const update = useUpdateUser();
  const [form, setForm] = useState({ name: user.name, role: user.role, password: '' });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        id: user.id,
        data: {
          name: form.name,
          role: form.role,
          ...(form.password ? { password: form.password } : {}),
        },
      });
      toast.success('User updated');
      setOpen(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="ghost" size="icon"><Pencil size={14} className="text-muted-foreground" /></Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit user</DialogTitle></DialogHeader>
        <form onSubmit={submit} className="space-y-3" autoComplete="off">
          <div className="space-y-1.5">
            <Label htmlFor="ename">Name</Label>
            <Input id="ename" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="erole">Role</Label>
            <select id="erole" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-[13px]">
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="epass">New password <span className="text-muted-foreground">(blank = keep current)</span></Label>
            <Input id="epass" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
          </div>
          <DialogFooter><Button type="submit" disabled={update.isPending}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
