import { Button, Empty } from "@cloudflare/kumo";

export interface WelcomeScreenProps {
  /** Called when the user is ready to move on to the setup form. */
  onGetStarted: () => void;
}

/**
 * First-run landing screen shown only when there are zero storage
 * connections and the user hasn't started setup yet. Gives a calm
 * introduction to what the app does before asking for any credentials.
 */
export function WelcomeScreen({ onGetStarted }: WelcomeScreenProps) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-8 text-center">
      <h1 className="lopload-heading text-2xl font-semibold">Lopload</h1>
      <Empty
        title="Drag files in, watch them upload, know for certain they arrived."
        description="Lopload is a calm file manager for your cloud storage — connect a folder space once, then upload, browse, and verify transfers without wondering if they made it."
        contents={
          <Button variant="primary" onClick={onGetStarted}>
            Add a storage connection
          </Button>
        }
      />
    </div>
  );
}
