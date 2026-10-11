import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, Checkbox } from "@work-shape/catalyst-app-kit";

const steps = [
  {
    id: "conflict",
    label: "Conflict check",
    description: "No existing client stands against the mandate."
  },
  {
    id: "identity",
    label: "Identity check",
    description: "Identity of the client and of the beneficial owner."
  },
  {
    id: "letter",
    label: "Engagement letter",
    description: "Signed by the client and by a partner."
  },
  {
    id: "access",
    label: "Access to the books",
    description: "Read access to the accounting system."
  },
  {
    id: "kickoff",
    label: "Kick-off meeting",
    description: "Contacts, deadlines and the first monthly close."
  }
];

function Steps() {
  const [done, setDone] = useState<readonly string[]>([]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Steps for a new client</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p>
          {done.length} of {steps.length} done
        </p>
        {steps.map((step) => (
          <Checkbox
            key={step.id}
            label={step.label}
            description={step.description}
            checked={done.includes(step.id)}
            onCheckedChange={(checked) =>
              setDone(checked ? [...done, step.id] : done.filter((id) => id !== step.id))
            }
          />
        ))}
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute("/")({ component: Steps });
