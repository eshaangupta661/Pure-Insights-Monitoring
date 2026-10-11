import { Link } from 'react-router-dom';
import { Card, EmptyState } from '../components/ui';

/** Placeholder for pages built in Phase 5b, so the sidebar and links already resolve. */
export default function ComingSoonPage({
  title,
  notFound = false,
}: {
  title: string;
  notFound?: boolean;
}) {
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-extrabold tracking-tight text-gray-900">{title}</h1>
      <Card className="mt-4">
        {notFound ? (
          <EmptyState title="There is nothing at this address" />
        ) : (
          <EmptyState title="Not built yet" hint="This page arrives in the next phase." />
        )}
        <p className="pb-2 text-center text-sm">
          <Link to="/" className="text-accent hover:underline">
            Back to Overview
          </Link>
        </p>
      </Card>
    </div>
  );
}
