import { createFileRoute } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-app-kit";
import { rates } from "../rates";

function Rates() {
  return (
    <section className="flex flex-col gap-4">
      <h1>Hourly rates</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Who</TableHead>
            <TableHead>EUR per hour</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rates.map((entry) => (
            <TableRow key={entry.id}>
              <TableCell>{entry.label}</TableCell>
              <TableCell>{entry.rate}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export const Route = createFileRoute("/rates")({ component: Rates });
