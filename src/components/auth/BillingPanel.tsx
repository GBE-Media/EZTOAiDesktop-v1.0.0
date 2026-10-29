import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { openBillingPage, type BillingPage } from "@/services/billing/client";

export function BillingPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = useState("");

  const go = async (page: BillingPage) => {
    setError("");
    try {
      await openBillingPage(page);
    } catch {
      setError("Couldn't open your browser. Visit bidveraai.com/settings to manage billing.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Subscription &amp; Users</DialogTitle>
          <DialogDescription>
            Billing and team seats are managed on the BidveraAi website.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            BidveraAi is $300 per user per month, with a 7-day free trial. AI usage is
            billed at provider cost plus 20% on the monthly invoice, and is free during the
            trial. AI features need an active subscription or a seat on your company's account.
          </p>
          <p>
            Account owners add or remove seats, update cards and cancel from Account
            Settings. Teammates are invited from the same page.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => void go("pricing")}>
            Plans &amp; free trial
          </Button>
          <Button onClick={() => void go("manage")}>Manage subscription</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
