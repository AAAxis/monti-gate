// Run-finished notifications and their per-user read state.
//
// The rows are org-scoped and written by whichever member's launcher finished
// the run; read state is a row per (notification, person) in
// notification_reads, insert-only -- see the migration for why that beats a
// read_by array. Everything here is plain inserts and deletes; there is no
// update path at all.
import type {ScoutNotification} from '../types';
import {optionalClient, raise, requireClient} from './client';
import {notificationToRow, rowToNotification} from './mappers';
import type {NotificationRow, NotificationReadRow} from './rows';

const COLUMNS = 'id,org_id,kind,title,body,status,automation_id,run_id,created_by,created_at';

// The most recent hundred. The bell is an inbox, not an archive -- the run
// history view is the durable record, and a bell that loads every notification
// an org has ever produced grows without bound on every window focus.
const LIST_LIMIT = 100;

export async function list(orgId: string): Promise<ScoutNotification[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('notifications')
      .select(COLUMNS)
      .eq('org_id', orgId)
      .order('created_at', {ascending: false})
      .limit(LIST_LIMIT);
  raise(error, 'notifications.list');
  return ((data || []) as unknown as NotificationRow[]).map(rowToNotification);
}

export async function create(orgId: string, notification: ScoutNotification): Promise<void> {
  const client = requireClient();
  const {error} = await client
      .from('notifications')
      .insert(notificationToRow(orgId, notification));
  raise(error, 'notifications.create');
}

export async function remove(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const {error} = await client
      .from('notifications')
      .delete()
      .eq('org_id', orgId)
      .in('id', ids);
  raise(error, 'notifications.remove');
}

// Which notifications I have read. No orgId: RLS scopes the table to
// user_id = auth.uid() in every direction, and a read is about a person, not
// a tenant -- the same exception `account` gets in the rules at the top of
// index.ts.
export async function listReads(): Promise<string[]> {
  const client = optionalClient();
  if (!client) {
    return [];
  }
  const {data, error} = await client
      .from('notification_reads')
      .select('notification_id');
  raise(error, 'notifications.listReads');
  return ((data || []) as unknown as Pick<NotificationReadRow, 'notification_id'>[])
      .map((row) => row.notification_id);
}

// Plain inserts, NOT an upsert, even though marking something read twice is
// routine (two windows, one popover each). The house rule is that nothing in
// src/db/ upserts; here the duplicate-key failure is simply not an error --
// the row saying "read" already exists, which is the exact state this call
// wanted. 23505 is swallowed for that reason and nothing else is.
//
// One insert per id rather than one batch: a batch fails atomically, so a
// single already-read id would unmark nothing and silently leave every other
// id unread.
export async function markRead(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const client = requireClient();
  const {data} = await client.auth.getUser();
  const userId = data.user?.id;
  if (!userId) {
    return;
  }
  for (const id of ids) {
    const {error} = await client
        .from('notification_reads')
        .insert({notification_id: id, user_id: userId});
    if (error && error.code !== '23505') {
      raise(error, 'notifications.markRead');
    }
  }
}
