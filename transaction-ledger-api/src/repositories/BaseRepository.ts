import { DB } from '../database/DB.ts';
import { ModelNotFoundException } from '../exceptions/ModelNotFoundException.ts';

export abstract class BaseRepository<T> {
  /** Configure the model (name, table and mass-assignable columns). */
  abstract model(): { name: string; table: string; fillable: string[] };

  /** Find model record for given id. */
  async find(id: string): Promise<T | null> {
    const { rows } = await DB.query(`SELECT * FROM ${this.model().table} WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Like Eloquent's findOrFail(): throws ModelNotFoundException (rendered as 404) when there is no such record. */
  async findOrFail(id: string): Promise<T> {
    const model = await this.find(id);
    if (!model) throw new ModelNotFoundException(this.model().name);
    return model;
  }

  /** Create model record from the fillable keys of `input`; anything else is ignored. */
  async create(input: Record<string, unknown>): Promise<T> {
    const { table, fillable } = this.model();
    const columns = fillable.filter((column) => input[column] !== undefined);
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const { rows } = await DB.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      columns.map((column) => input[column]),
    );
    return rows[0];
  }
}
