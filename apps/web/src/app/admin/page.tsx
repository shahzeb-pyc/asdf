import { redirect } from 'next/navigation';

/**
 * Admin section home: redirects to the subscriptions approvals
 * view, the admin panel home.
 */
export default function AdminHomePage() {
  redirect('/admin/subscriptions');
}
