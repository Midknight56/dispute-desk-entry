import { useEffect, useRef, useState } from 'react';
import { formatMoney, type TileValues } from '../format';

function Count({ value, money = false }: { value: number; money?: boolean }) {
  const [shown, setShown] = useState(value);
  const previous = useRef(value);
  useEffect(() => {
    const start = previous.current;
    previous.current = value;
    if (start === value) return;
    const began = performance.now();
    let frame = 0;
    const animate = (time: number) => {
      // a frame time can be a little before `began`: never let progress go below 0 (that showed -$1.30)
      const progress = Math.max(0, Math.min(1, (time - began) / 400));
      setShown(start + (value - start) * progress);
      if (progress < 1) frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <>{money ? formatMoney(shown.toFixed(2)) : Math.round(shown)}</>;
}

export default function Tiles({ values, loaded }: { values: TileValues; loaded: boolean }) {
  return (
    <dl className="tiles" aria-label="Summary">
      <div className="tile">
        <dt>On hold</dt>
        <dd>{loaded ? <Count value={values.onHold} money /> : '-'}</dd>
        {loaded && values.leftOut > 0 && <dd className="tile-text">USD only, {values.leftOut} case{values.leftOut === 1 ? '' : 's'} in another currency left out</dd>}
      </div>
      <div className="tile">
        <dt>Open</dt>
        <dd>{loaded ? <Count value={values.open} /> : '-'}</dd>
      </div>
      <div className="tile">
        <dt>Next deadline</dt>
        <dd className="tile-text">{loaded ? values.nextDeadline : '-'}</dd>
      </div>
      <div className="tile">
        <dt>Settled</dt>
        <dd>{loaded ? <Count value={values.settled} /> : '-'}</dd>
      </div>
    </dl>
  );
}
