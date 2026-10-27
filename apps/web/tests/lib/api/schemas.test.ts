import { describe, expect, it } from 'vitest';
import {
  BatchMediaResponseSchema,
  BulkEnqueueResponseSchema,
  ByocSettingsResponseSchema,
  CheckDuplicatesResponseSchema,
  ConnectCompleteResponseSchema,
  DestinationDetailResponseSchema,
  DisconnectAccountResponseSchema,
  FolderListResponseSchema,
  ListFacebookAccountsResponseSchema,
  ListFacebookPagesResponseSchema,
  ListQueueItemsResponseSchema,
  ListQueueSlotsResponseSchema,
  ListSocialAccountsResponseSchema,
  ListWorkspacesResponseSchema,
  MagicLinkResponseSchema,
  MediaListResponseSchema,
  PageDetailResponseSchema,
  PlatformCredentialsResponseSchema,
  RevealByocSecretResponseSchema,
  RevealPlatformSecretResponseSchema,
  SaveCredentialsResponseSchema,
  SwitchWorkspaceResponseSchema,
  UploadUrlResponseSchema,
  WorkspaceMutationResponseSchema,
} from '@/lib/api/schemas';

const UUID = '11111111-1111-4111-a111-111111111111';
const UUID2 = '22222222-2222-4222-a222-222222222222';
const ISO = '2026-10-23T08:00:00.000Z';

describe('accounts schemas', () => {
  it('parses the Facebook accounts list as the route constructs it', () => {
    const result = ListFacebookAccountsResponseSchema.parse({
      accounts: [
        {
          id: UUID,
          fbAccountId: '123456789',
          displayName: 'Jane Creator',
          profilePictureUrl: 'https://example.com/pic.jpg',
          gender: null,
          accountLink: null,
          status: 'active',
          tokenExpiresAt: ISO,
          connectedPagesCount: 1,
          connectedPages: [
            { id: UUID2, pageName: 'My Page', profilePictureUrl: null },
          ],
          createdAt: ISO,
          updatedAt: ISO,
        },
      ],
      total: 1,
    });
    expect(result.accounts[0]?.connectedPages?.[0]?.pageName).toBe('My Page');
  });

  it('rejects an account whose rendered displayName is not a string', () => {
    const bad = {
      accounts: [
        {
          id: UUID,
          fbAccountId: '1',
          displayName: 42,
          status: 'active',
          connectedPagesCount: 0,
          createdAt: ISO,
          updatedAt: ISO,
        },
      ],
      total: 1,
    };
    expect(ListFacebookAccountsResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('parses disconnect + unified social list + magic link responses', () => {
    expect(
      DisconnectAccountResponseSchema.parse({
        success: true,
        accountId: UUID,
        disconnectedPagesCount: 2,
      }).disconnectedPagesCount
    ).toBe(2);
    const social = ListSocialAccountsResponseSchema.parse({
      accounts: [
        {
          id: UUID,
          platform: 'instagram',
          externalAccountId: 'ext-1',
          displayName: 'Insta',
          avatarUrl: null,
          status: 'active',
          tokenExpiresAt: null,
          destinations: [
            {
              id: UUID2,
              externalDestinationId: 'dest-1',
              name: 'Dest',
              handle: '@dest',
              avatarUrl: null,
              timezone: 'UTC',
              status: 'active',
              accountType: 'BUSINESS',
            },
          ],
        },
      ],
    });
    expect(social.accounts[0]?.platform).toBe('instagram');
    expect(social.accounts[0]?.destinations[0]?.accountType).toBe('BUSINESS');
    expect(
      MagicLinkResponseSchema.parse({
        success: true,
        magicUrl: 'https://app.example/connect/facebook?token=abc',
        expiresAt: ISO,
        expiresInSeconds: 900,
      }).expiresInSeconds
    ).toBe(900);
  });
});

describe('pages schemas', () => {
  const page = {
    id: UUID,
    facebookAccountId: UUID2,
    accountDisplayName: 'Jane Creator',
    fbPageId: '999',
    pageName: 'My Page',
    profilePictureUrl: null,
    category: 'Digital creator',
    timezone: 'UTC',
    startingFollowers: 10,
    currentFollowers: 25,
    followersGained: 15,
    followersCount: 25,
    status: 'active',
    tasks: ['MANAGE'],
    createdAt: ISO,
    updatedAt: ISO,
    rateLimitedAt: null,
  };

  it('parses the pages list and the page detail (page + queueCounts)', () => {
    expect(ListFacebookPagesResponseSchema.parse({ pages: [page], total: 1 }).total).toBe(1);
    const detail = PageDetailResponseSchema.parse({
      page,
      queueCounts: { queued: 3, publishing: 1, published: 9, failed: 0 },
    });
    expect(detail.queueCounts.queued).toBe(3);
  });

  it('rejects an unknown page status', () => {
    const bad = { pages: [{ ...page, status: 'mystery' }], total: 1 };
    expect(ListFacebookPagesResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('queue schemas', () => {
  it('parses queue items, bulk results and slots', () => {
    const list = ListQueueItemsResponseSchema.parse({
      items: [
        {
          id: UUID,
          userId: UUID2,
          pageId: UUID,
          slotId: null,
          mediaId: null,
          postFormat: 'text',
          linkUrl: null,
          scheduledTime: ISO,
          caption: 'Hello',
          firstComment: null,
          status: 'queued',
          retryCount: 0,
          maxRetries: 3,
          fbPostId: null,
          fbCommentId: null,
          publishedAt: null,
          createdAt: ISO,
          updatedAt: ISO,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      queuedCount: 1,
    });
    expect(list.items[0]?.caption).toBe('Hello');
    expect(
      BulkEnqueueResponseSchema.parse({
        results: [{ ok: true, itemId: UUID }, { ok: false, error: 'No slots' }],
      }).results
    ).toHaveLength(2);
    const slots = ListQueueSlotsResponseSchema.parse({
      slots: [
        {
          id: UUID,
          userId: UUID2,
          pageId: UUID,
          slotTime: '09:30',
          timezone: 'UTC',
          isActive: true,
          allowedFormats: ['reel', 'image'],
          createdAt: ISO,
          updatedAt: ISO,
        },
      ],
      total: 1,
    });
    expect(slots.slots[0]?.slotTime).toBe('09:30');
  });

  it('rejects a queue item whose media thumbnail is the wrong type', () => {
    const bad = {
      items: [
        {
          id: UUID,
          userId: UUID2,
          pageId: UUID,
          slotId: null,
          mediaId: null,
          postFormat: 'reel',
          scheduledTime: ISO,
          caption: 'x',
          firstComment: null,
          status: 'queued',
          retryCount: 0,
          maxRetries: 3,
          fbPostId: null,
          fbCommentId: null,
          publishedAt: null,
          createdAt: ISO,
          updatedAt: ISO,
          media: {
            name: 'clip.mp4',
            mediaType: 'video',
            thumbnailUrl: 42,
            url: 'https://example.com/clip.mp4',
            aspectRatio: '9:16',
            durationSeconds: 12,
          },
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    };
    expect(ListQueueItemsResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('media schemas', () => {
  const item = {
    id: UUID,
    userId: UUID2,
    folderId: null,
    name: 'clip.mp4',
    fileSize: 1024,
    mimeType: 'video/mp4',
    mediaType: 'video',
    storageKey: 'media/clip.mp4',
    url: 'https://example.com/clip.mp4',
    thumbnailKey: null,
    thumbnailUrl: null,
    durationSeconds: 12,
    aspectRatio: '9:16',
    captionText: null,
    width: 1080,
    height: 1920,
    createdAt: ISO,
    updatedAt: ISO,
  };

  it('parses the media list, folders, batch, upload-url and duplicates', () => {
    expect(
      MediaListResponseSchema.parse({ items: [item], total: 1, limit: 50, offset: 0, nextCursor: null }).items[0]?.name
    ).toBe('clip.mp4');
    expect(
      FolderListResponseSchema.parse({
        folders: [
          {
            id: UUID,
            userId: UUID2,
            parentId: null,
            name: 'Root',
            itemCount: 3,
            subfolderCount: 1,
            createdAt: ISO,
            updatedAt: ISO,
          },
        ],
        unorganizedCount: 2,
      }).unorganizedCount
    ).toBe(2);
    expect(
      BatchMediaResponseSchema.parse({ success: true, action: 'move', affectedCount: 4 }).affectedCount
    ).toBe(4);
    expect(
      UploadUrlResponseSchema.parse({
        mediaId: UUID,
        mediaKey: 'k',
        mediaUploadUrl: 'https://upload.example/1',
        thumbnailKey: 't',
        thumbnailUploadUrl: 'https://upload.example/2',
        publicMediaUrl: 'https://example.com/clip.mp4',
        publicThumbnailUrl: 'https://example.com/clip.webp',
        expiresInSeconds: 600,
      }).mediaId
    ).toBe(UUID);
    expect(
      CheckDuplicatesResponseSchema.parse({
        duplicates: [{ clientKey: 'c1', existingItem: item }],
      }).duplicates[0]?.existingItem.id
    ).toBe(UUID);
  });
});

describe('settings, workspaces and connect schemas', () => {
  it('parses BYOC + platform credential payloads', () => {
    expect(
      ByocSettingsResponseSchema.parse({
        workspaceId: UUID,
        subdomain: 'alpha',
        fbAppId: '12345',
        fbAppSecretHint: null,
        hasSecret: false,
        status: 'unverified',
        lastTestedAt: null,
        connectedAt: null,
      }).fbAppId
    ).toBe('12345');
    expect(
      SaveCredentialsResponseSchema.parse({
        success: true,
        hasSecret: true,
        status: 'unverified',
        connectedAt: ISO,
      }).hasSecret
    ).toBe(true);
    expect(
      PlatformCredentialsResponseSchema.parse({
        workspaceId: UUID,
        subdomain: 'alpha',
        platform: 'instagram',
        appId: '678',
        secretHint: '••••cret',
        hasSecret: true,
        status: 'valid',
        lastTestedAt: ISO,
        connectedAt: ISO,
      }).platform
    ).toBe('instagram');
    // The reveal actions (spec 139 N3) are the only payloads that
    // carry the secret itself.
    expect(RevealByocSecretResponseSchema.parse({ fbAppSecret: 'secret' }).fbAppSecret).toBe(
      'secret'
    );
    expect(RevealPlatformSecretResponseSchema.parse({ appSecret: 'secret' }).appSecret).toBe(
      'secret'
    );
  });

  it('parses workspace list, mutation and switch payloads', () => {
    const workspace = {
      id: UUID,
      ownerId: UUID2,
      name: 'Alpha',
      subdomain: 'alpha',
      createdAt: ISO,
      updatedAt: ISO,
    };
    expect(ListWorkspacesResponseSchema.parse({ workspaces: [workspace] }).workspaces).toHaveLength(1);
    expect(
      WorkspaceMutationResponseSchema.parse({ success: true, workspace }).workspace.subdomain
    ).toBe('alpha');
    expect(
      SwitchWorkspaceResponseSchema.parse({
        success: true,
        targetSubdomain: 'alpha',
        redirectUrl: 'https://alpha.example.com/',
      }).targetSubdomain
    ).toBe('alpha');
  });

  it('parses the destination detail and connect-complete payloads', () => {
    const detail = DestinationDetailResponseSchema.parse({
      destination: {
        id: UUID,
        externalDestinationId: 'page-1',
        name: 'My Page',
        handle: null,
        avatarUrl: null,
        timezone: 'UTC',
        status: 'active',
        accountType: null,
        platform: 'facebook',
        account: { id: UUID2, displayName: 'Jane', platform: 'facebook', status: 'active' },
      },
    });
    expect(detail.destination.account.displayName).toBe('Jane');
    expect(
      ConnectCompleteResponseSchema.parse({ accountsUrl: '/tenant/alpha/accounts', addedCount: 2 }).addedCount
    ).toBe(2);
  });
});
