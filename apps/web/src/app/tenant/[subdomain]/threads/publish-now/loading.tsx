export default function ThreadsPublishNowLoading() {
  return (
    <div className="mx-auto w-full max-w-300 px-4 py-6 sm:px-6" aria-busy="true" aria-label="Loading Publish Now">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center py-6 sm:py-10">
        <div className="w-full space-y-8">
          <div className="space-y-3 text-center">
            <div className="mx-auto mb-6 size-16 rounded-2xl bg-subtle" />
            <div className="mx-auto h-9 w-56 rounded-sm bg-subtle" />
            <div className="mx-auto h-5 w-80 max-w-full rounded-sm bg-subtle" />
          </div>
          <div className="rounded-2xl border border-line bg-subtle p-4 sm:p-6">
            <div className="h-6 w-40 rounded-sm bg-canvas" />
          </div>
        </div>
      </div>
    </div>
  );
}
