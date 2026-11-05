import { readiness } from './readiness';
import type { Dispute } from '../format';

export default function Readiness({ data }: { data?: Dispute }) {
  if (!data) return null;
  const result = readiness(data);
  const missingRecords = result.missing.filter((item) => item !== 'response');
  const title = [
    result.held.length ? `${result.held.join(', ')} held` : 'nothing held',
    ...(missingRecords.length ? [`${missingRecords.join(', ')} missing`] : []),
    ...(!data.filed_at ? ['not filed'] : []),
  ].join('; ');
  return (
    <span className="readiness-marks" title={title} aria-label={title}>
      {result.filled.map((filled, index) => (
        <i className={filled ? 'readiness-mark filled' : 'readiness-mark'} key={index} />
      ))}
    </span>
  );
}
