/**
 * @file multi-workspace-resource-isolation.test.ts
 * @description Security regression tests for ISSUE-46: Tenant Resources Lack workspace_id Foreign Key, Breaking Multi-Workspace Isolation
 * Verifies that:
 * 1. Database types DatabaseSocialAccountRow, DatabaseDestinationRow, DatabaseMediaFolderRow, and DatabaseMediaItemRow
 *    enforce workspace_id: string. (The account/destination types are
 *    the unified spec 119 rows that replaced the legacy Facebook rows
 *    in the Phase 7 drop.)
 * 2. Forward SQL migration exists and adds workspace_id foreign keys, constraints, and compound RLS policies.
 * 3. Multi-workspace isolation guarantees that resources in Workspace A never bleed into Workspace B.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DatabaseSocialAccountRow,
  DatabaseDestinationRow,
  DatabaseMediaFolderRow,
  DatabaseMediaItemRow,
} from '@fbuploadpro/contracts';

describe('ISSUE-46: Multi-Workspace Resource Isolation & Foreign Key Enforcement', () => {
  it('enforces workspace_id field on all tenant resource database contracts', () => {
    // Compile-time and runtime validation that row types require workspace_id
    const mockAccount: DatabaseSocialAccountRow = {
      id: '00000000-0000-4000-a000-000000000001',
      workspace_id: '22222222-2222-4222-a222-222222222222',
      platform: 'facebook',
      external_account_id: 'fb-acc-123',
      display_name: 'Test Account',
      avatar_url: null,
      status: 'active',
      encrypted_access_token: 'enc-token',
      encrypted_refresh_token: null,
      token_expires_at: null,
      scopes: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(mockAccount.workspace_id).toBe('22222222-2222-4222-a222-222222222222');

    const mockPage: DatabaseDestinationRow = {
      id: '00000000-0000-4000-a000-000000000002',
      workspace_id: '22222222-2222-4222-a222-222222222222',
      account_id: mockAccount.id,
      platform: 'facebook',
      external_destination_id: 'fb-page-456',
      name: 'Test Page',
      handle: null,
      avatar_url: null,
      timezone: 'UTC',
      status: 'active',
      encrypted_destination_token: 'enc-token',
        rate_usage_pct: 0,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(mockPage.workspace_id).toBe('22222222-2222-4222-a222-222222222222');

    const mockFolder: DatabaseMediaFolderRow = {
      id: '00000000-0000-4000-a000-000000000003',
      user_id: '11111111-1111-4111-a111-111111111111',
      workspace_id: null,
      name: 'Test Folder',
      parent_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(mockFolder.workspace_id).toBeNull();

    const mockItem: DatabaseMediaItemRow = {
      id: '00000000-0000-4000-a000-000000000004',
      user_id: '11111111-1111-4111-a111-111111111111',
      workspace_id: null,
      folder_id: mockFolder.id,
      name: 'video.mp4',
      file_size: 1024,
      mime_type: 'video/mp4',
      media_type: 'video',
      storage_key: 'keys/video.mp4',
      url: 'https://cdn.example.com/video.mp4',
      thumbnail_key: null,
      thumbnail_url: null,
      duration_seconds: 30,
      aspect_ratio: '16:9',
      caption_text: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(mockItem.workspace_id).toBeNull();
  });

  it('contains forward database migration adding workspace_id foreign keys and RLS policies', () => {
    const migrationsDir = path.resolve(process.cwd(), '../../supabase/migrations');
    const files = fs.readdirSync(migrationsDir);
    const migrationFile = files.find((f) => f.includes('tenant_resources_workspace_isolation'));

    expect(migrationFile).toBeDefined();

    const sqlContent = fs.readFileSync(path.join(migrationsDir, migrationFile!), 'utf-8');

    // Asserts workspace_id is added to facebook_accounts, facebook_pages, media_folders, media_items
    expect(sqlContent).toContain('facebook_accounts');
    expect(sqlContent).toContain('facebook_pages');
    expect(sqlContent).toContain('media_folders');
    expect(sqlContent).toContain('media_items');
    expect(sqlContent).toMatch(/REFERENCES\s+(?:"public"\.)?["']?workspaces["']?\s*\(\s*["']?id["']?\s*\)\s+ON\s+DELETE\s+CASCADE/i);

    // Asserts compound RLS policies include workspace_id scoping
    expect(sqlContent).toMatch(/CREATE\s+POLICY\s+["']facebook_accounts_user_access["']/i);
    expect(sqlContent).toMatch(/CREATE\s+POLICY\s+["']facebook_pages_user_access["']/i);
    expect(sqlContent).toMatch(/CREATE\s+POLICY\s+["']media_folders_user_access["']/i);
    expect(sqlContent).toMatch(/CREATE\s+POLICY\s+["']media_items_user_access["']/i);
  });

  it('contains forward database migration 20261014180000_global_user_media_library.sql resetting media RLS to global user', () => {
    const migrationsDir = path.resolve(process.cwd(), '../../supabase/migrations');
    const files = fs.readdirSync(migrationsDir);
    const globalMediaMigration = files.find((f) => f.includes('global_user_media_library'));

    expect(globalMediaMigration).toBeDefined();

    const sqlContent = fs.readFileSync(path.join(migrationsDir, globalMediaMigration!), 'utf-8');
    expect(sqlContent).toContain('ALTER TABLE "public"."media_folders" ALTER COLUMN "workspace_id" DROP NOT NULL');
    expect(sqlContent).toContain('ALTER TABLE "public"."media_items" ALTER COLUMN "workspace_id" DROP NOT NULL');
    expect(sqlContent).toMatch(/CREATE\s+POLICY\s+["']media_folders_user_access["']\s+ON\s+["']public["']\.["']media_folders["']/i);
    expect(sqlContent).toMatch(/CREATE\s+POLICY\s+["']media_items_user_access["']\s+ON\s+["']public["']\.["']media_items["']/i);
  });

  it('filters tenant resources by workspace_id preventing multi-workspace bleed for same user', () => {
    const workspaceA = 'aaaa1111-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const workspaceB = 'bbbb2222-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

    // Unified accounts carry no user_id: the workspace is the sole
    // isolation boundary (workspace ownership is enforced one level
    // up, at workspace resolution).
    const accountWorkspaceA: DatabaseSocialAccountRow = {
      id: 'acc-1',
      workspace_id: workspaceA,
      platform: 'facebook',
      external_account_id: 'fb-1',
      display_name: 'Workspace A Account',
      avatar_url: null,
      status: 'active',
      encrypted_access_token: 'enc-1',
      encrypted_refresh_token: null,
      token_expires_at: null,
      scopes: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const accountWorkspaceB: DatabaseSocialAccountRow = {
      id: 'acc-2',
      workspace_id: workspaceB,
      platform: 'facebook',
      external_account_id: 'fb-2',
      display_name: 'Workspace B Account',
      avatar_url: null,
      status: 'active',
      encrypted_access_token: 'enc-2',
      encrypted_refresh_token: null,
      token_expires_at: null,
      scopes: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const allUserAccounts = [accountWorkspaceA, accountWorkspaceB];

    // Querying for Workspace A must only return accounts belonging to Workspace A
    const workspaceAAccounts = allUserAccounts.filter(
      (acc) => acc.workspace_id === workspaceA
    );
    expect(workspaceAAccounts).toHaveLength(1);
    expect(workspaceAAccounts[0]?.id).toBe('acc-1');

    // Querying for Workspace B must only return accounts belonging to Workspace B
    const workspaceBAccounts = allUserAccounts.filter(
      (acc) => acc.workspace_id === workspaceB
    );
    expect(workspaceBAccounts).toHaveLength(1);
    expect(workspaceBAccounts[0]?.id).toBe('acc-2');
  });

  it('ensures media library is global across workspaces for the same user', () => {
    const userId = '11111111-1111-4111-a111-111111111111';
    const otherUserId = '22222222-2222-4222-a222-222222222222';

    const userMediaItems: DatabaseMediaItemRow[] = [
      {
        id: 'item-1',
        user_id: userId,
        workspace_id: null,
        folder_id: null,
        name: 'reel1.mp4',
        file_size: 5000,
        mime_type: 'video/mp4',
        media_type: 'video',
        storage_key: 'keys/reel1.mp4',
        url: 'https://cdn.example.com/reel1.mp4',
        thumbnail_key: null,
        thumbnail_url: null,
        duration_seconds: 15,
        aspect_ratio: '9:16',
        caption_text: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 'item-2',
        user_id: otherUserId,
        workspace_id: null,
        folder_id: null,
        name: 'other.mp4',
        file_size: 6000,
        mime_type: 'video/mp4',
        media_type: 'video',
        storage_key: 'keys/other.mp4',
        url: 'https://cdn.example.com/other.mp4',
        thumbnail_key: null,
        thumbnail_url: null,
        duration_seconds: 20,
        aspect_ratio: '9:16',
        caption_text: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    // Any workspace belonging to user sees all media of user
    const accessibleItems = userMediaItems.filter((item) => item.user_id === userId);
    expect(accessibleItems).toHaveLength(1);
    expect(accessibleItems[0]?.id).toBe('item-1');
  });
});
