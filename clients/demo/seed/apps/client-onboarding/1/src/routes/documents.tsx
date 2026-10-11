import { createFileRoute } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@work-shape/catalyst-app-kit";

const documents = [
  { name: "Commercial register extract", from: "Client", due: "Before the engagement letter" },
  { name: "Last two annual statements", from: "Previous adviser", due: "Within two weeks" },
  { name: "Tax assessments of the last three years", from: "Client", due: "Within two weeks" },
  {
    name: "Power of attorney for the tax office",
    from: "Client",
    due: "With the engagement letter"
  }
];

function Documents() {
  return (
    <section className="flex flex-col gap-4">
      <h1>Documents to collect</h1>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Document</TableHead>
            <TableHead>From</TableHead>
            <TableHead>Due</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((document) => (
            <TableRow key={document.name}>
              <TableCell>{document.name}</TableCell>
              <TableCell>{document.from}</TableCell>
              <TableCell>{document.due}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export const Route = createFileRoute("/documents")({ component: Documents });
