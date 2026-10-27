import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum AuditCategory {
  // One row per API request.
  REQUEST = 'request',
  // Something happened to a record: created, status changed, exported...
  EVENT = 'event',
  // Background work: schedulers, email sending, retention.
  JOB = 'job',
}

export enum AuditActorType {
  ADMIN = 'admin',
  PUBLIC = 'public',
  SYSTEM = 'system',
}

export enum AuditOutcome {
  SUCCESS = 'success',
  FAILURE = 'failure',
}

/**
 * Append-only audit trail: who did what, to what, when and with what result.
 * The actor is a snapshot (id, email, role) with no foreign key, so entries outlive the user.
 */
@Entity({ name: 'audit_logs' })
@Index(['entityType', 'entityId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Index()
  @Column({ type: 'enum', enum: AuditCategory })
  category!: AuditCategory;

  // e.g. "application.status_changed", "report.exported", "http.request".
  @Index()
  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'enum', enum: AuditOutcome, default: AuditOutcome.SUCCESS })
  outcome!: AuditOutcome;

  @Column({ type: 'enum', enum: AuditActorType })
  actorType!: AuditActorType;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true })
  actorEmail!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  actorRole!: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  entityType!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  entityId!: string | null;

  // One readable line, e.g. "Status received → hired".
  @Column({ type: 'varchar', length: 500, nullable: true })
  summary!: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  data!: Record<string, unknown>;

  // Request details; null for jobs.
  @Column({ type: 'varchar', length: 10, nullable: true })
  method!: string | null;

  // Route pattern, e.g. /api/v1/admin/applications/:id, so requests group by endpoint.
  @Index()
  @Column({ type: 'varchar', length: 300, nullable: true })
  route!: string | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  path!: string | null;

  @Column({ type: 'int', nullable: true })
  statusCode!: number | null;

  @Column({ type: 'int', nullable: true })
  durationMs!: number | null;

  @Index()
  @Column({ type: 'varchar', length: 128, nullable: true })
  requestId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ipHash!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  userAgent!: string | null;
}
