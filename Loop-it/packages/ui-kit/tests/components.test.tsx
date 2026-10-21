import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, ConfirmDialog, DataTable, StatusPill } from '../src';

describe('ui-kit components', () => {
  it('renders button variants and status pills', () => {
    const html = renderToStaticMarkup(<><Button variant="danger">Delete</Button><StatusPill status="T3" /></>);
    expect(html).toContain('ui-button--danger');
    expect(html).toContain('ui-badge--danger');
  });

  it('renders data tables and confirm dialogs', () => {
    const table = renderToStaticMarkup(<DataTable rows={[{ id: '1', name: 'Acme' }]} getRowKey={(row) => row.id} columns={[{ key: 'name', header: 'Name', render: (row) => row.name }]} />);
    expect(table).toContain('<table');
    const dialog = renderToStaticMarkup(<ConfirmDialog open title="Confirm" message="Proceed?" destructive onCancel={() => undefined} onConfirm={() => undefined} />);
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('ui-button--danger');
  });
});
