import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input
} from "@work-shape/catalyst-app-kit";

const RATE = 140;

function Estimate() {
  const [hours, setHours] = useState("12");
  const fee = Math.max(0, Number(hours) || 0) * RATE;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly fee</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field label="Hours per month">
          <Input
            type="number"
            min={0}
            value={hours}
            onChange={(event) => setHours(event.target.value)}
          />
        </Field>
        <p>
          {fee.toLocaleString("en")} EUR at {RATE} EUR per hour
        </p>
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute("/")({ component: Estimate });
