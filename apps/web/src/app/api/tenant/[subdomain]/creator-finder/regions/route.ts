import { type NextRequest, NextResponse } from 'next/server';
import { fetchRegionList, RegionListResponseSchema } from '@fbuploadpro/contracts';
import {
  creatorFinderErrorResponse,
  getCreatorFinderKeys,
  requireTenantSession,
} from '../lib';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> },
) {
  const { subdomain } = await params;
  const authError = await requireTenantSession(request, subdomain);
  if (authError) return authError;
  try {
    const result = await fetchRegionList({ apiKeys: getCreatorFinderKeys() });
    return NextResponse.json(RegionListResponseSchema.parse(result));
  } catch (err) {
    return creatorFinderErrorResponse(err);
  }
}
