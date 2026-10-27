import { describe, expect, it } from 'vitest';
import {
  DESTINATION_STATUS_TO_WIRE_SQL,
  unifiedDestinationStatusToWire,
  wirePageStatusToUnified,
} from '@/lib/server/facebook-wire';

describe('facebook-wire checkpoint marker', () => {
  describe('unifiedDestinationStatusToWire', () => {
    it("reads 'error' + checkpoint marker as 'page_checkpoint'", () => {
      expect(
        unifiedDestinationStatusToWire('error', { fb_status: 'checkpoint' })
      ).toBe('page_checkpoint');
    });

    it("reads 'error' without the marker as 'invalid_token' (unchanged)", () => {
      expect(unifiedDestinationStatusToWire('error', {})).toBe('invalid_token');
      expect(unifiedDestinationStatusToWire('error', null)).toBe(
        'invalid_token'
      );
      expect(
        unifiedDestinationStatusToWire('error', { fb_status: 'paused' })
      ).toBe('invalid_token');
    });

    it("reads 'disconnected' + paused marker as 'paused' (unchanged)", () => {
      expect(
        unifiedDestinationStatusToWire('disconnected', { fb_status: 'paused' })
      ).toBe('paused');
    });

    it('reads plain disconnected as disconnected (unchanged)', () => {
      expect(unifiedDestinationStatusToWire('disconnected', {})).toBe(
        'disconnected'
      );
    });

    it('reads the other statuses unchanged', () => {
      expect(unifiedDestinationStatusToWire('active', {})).toBe('active');
      expect(unifiedDestinationStatusToWire('rate_limited', {})).toBe(
        'fb_rate_limited'
      );
    });

    it('does not let the checkpoint marker leak onto other statuses', () => {
      expect(
        unifiedDestinationStatusToWire('active', { fb_status: 'checkpoint' })
      ).toBe('active');
      expect(
        unifiedDestinationStatusToWire('disconnected', {
          fb_status: 'checkpoint',
        })
      ).toBe('disconnected');
    });
  });

  describe('DESTINATION_STATUS_TO_WIRE_SQL', () => {
    it('checks the checkpoint branch before the error branch', () => {
      const checkpointAt = DESTINATION_STATUS_TO_WIRE_SQL.indexOf(
        "d.metadata->>'fb_status' = 'checkpoint'"
      );
      const errorAt = DESTINATION_STATUS_TO_WIRE_SQL.indexOf(
        "WHEN d.status = 'error' THEN 'invalid_token'"
      );
      expect(checkpointAt).toBeGreaterThan(-1);
      expect(errorAt).toBeGreaterThan(-1);
      expect(checkpointAt).toBeLessThan(errorAt);
    });

    it('maps error + checkpoint marker to page_checkpoint in the CASE', () => {
      expect(DESTINATION_STATUS_TO_WIRE_SQL).toContain(
        "WHEN d.status = 'error' AND d.metadata->>'fb_status' = 'checkpoint' THEN 'page_checkpoint'"
      );
    });

    it('keeps the paused branch first and unchanged', () => {
      expect(DESTINATION_STATUS_TO_WIRE_SQL).toContain(
        "WHEN d.status = 'disconnected' AND d.metadata->>'fb_status' = 'paused' THEN 'paused'"
      );
    });
  });

  describe('reactivate write side', () => {
    it("writing 'active' clears the marker, so a checkpoint page reactivates to active", () => {
      // wirePageStatusToUnified('active') is what the PATCH route feeds
      // the UPDATE with: status 'active' + pausedMarker false, which
      // both the SQL path (metadata - 'fb_status') and the Supabase
      // path (delete fb_status) turn into a marker-free active row —
      // so the read-back after reactivation is 'active', never
      // 'invalid_token' via a leftover marker.
      expect(wirePageStatusToUnified('active')).toEqual({
        status: 'active',
        pausedMarker: false,
      });
    });
  });
});
