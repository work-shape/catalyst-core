import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select
} from "@work-shape/catalyst-app-kit";
import { rates } from "../rates";

function Estimate() {
  const [hours, setHours] = useState("12");
  const [level, setLevel] = useState("adviser");
  const rate = rates.find((entry) => entry.id === level)?.rate ?? 0;
  const fee = Math.max(0, Number(hours) || 0) * rate;
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
        <Field label="Who does the work">
          <Select value={level} onChange={(event) => setLevel(event.target.value)}>
            {rates.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Field>
        <p>
          {fee.toLocaleString("en")} EUR at {rate} EUR per hour
        </p>
      </CardContent>
    </Card>
  );
}

export const Route = createFileRoute("/")({ component: Estimate });
