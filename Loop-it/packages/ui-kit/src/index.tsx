import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import './styles.css';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}

export function Button({ variant = 'primary', className = '', ...props }: ButtonProps) {
  return <button className={`ui-button ui-button--${variant} ${className}`.trim()} {...props} />;
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = 'neutral', className = '', ...props }: BadgeProps) {
  return <span className={`ui-badge ui-badge--${tone} ${className}`.trim()} {...props} />;
}

export interface StatusPillProps extends BadgeProps {
  status: string;
}

export function StatusPill({ status, tone = toneForStatus(status), children, ...props }: StatusPillProps) {
  return <Badge tone={tone} {...props}>{children ?? status}</Badge>;
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
}

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: readonly Column<T>[];
  getRowKey: (row: T) => string;
  empty?: ReactNode;
}

export function DataTable<T>({ rows, columns, getRowKey, empty }: DataTableProps<T>) {
  if (rows.length === 0) {
    return <div className="ui-table-empty">{empty ?? 'No data'}</div>;
  }
  return (
    <div className="ui-table-wrap">
      <table className="ui-table">
        <thead>
          <tr>{columns.map((column) => <th key={column.key}>{column.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.align ? `ui-align-${column.align}` : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const Table = DataTable;

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  actions?: ReactNode;
}

export function Card({ title, actions, children, className = '', ...props }: CardProps) {
  return <section className={`ui-card ${className}`.trim()} {...props}>{(title || actions) && <div className="ui-card-head"><h2>{title}</h2><div>{actions}</div></div>}<div className="ui-card-body">{children}</div></section>;
}

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}

export function Modal({ open, title, children, footer, onClose }: ModalProps) {
  if (!open) return null;
  return <div className="ui-modal-backdrop" role="presentation"><div className="ui-modal" role="dialog" aria-modal="true" aria-labelledby="ui-modal-title"><div className="ui-modal-head"><h2 id="ui-modal-title">{title}</h2><Button variant="ghost" onClick={onClose} aria-label="Close">×</Button></div><div className="ui-modal-body">{children}</div>{footer && <div className="ui-modal-foot">{footer}</div>}</div></div>;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', destructive = false, onCancel, onConfirm }: ConfirmDialogProps) {
  return <Modal open={open} title={title} onClose={onCancel} footer={<><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button></>}>{message}</Modal>;
}

export interface ToastProps {
  message: ReactNode;
  tone?: Tone;
  onDismiss?: () => void;
}

export function Toast({ message, tone = 'neutral', onDismiss }: ToastProps) {
  return <div className={`ui-toast ui-toast--${tone}`} role="status"><span>{message}</span>{onDismiss && <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>}</div>;
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return <div className="ui-empty"><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="ui-spinner" role="status" aria-label={label} />;
}

function toneForStatus(status: string): Tone {
  const normalized = status.toLowerCase();
  if (['open', 'warning', 'pending', 't1'].includes(normalized)) return 'warning';
  if (['resolved', 'success', 'ok'].includes(normalized)) return 'success';
  if (['dismissed', 'neutral'].includes(normalized)) return 'neutral';
  if (['t2', 't3', 'critical', 'suspended', 'danger'].includes(normalized)) return 'danger';
  return 'info';
}
