import React from 'react';

/** Small yellow "!" marker for an asset that isn't referenced anywhere. Place inside AssetCard's `badge`. */
export function UnreferencedBadge() {
  return (
    <span
      className='absolute top-0.5 left-0.5 flex items-center justify-center w-4 h-4 rounded-full bg-yellow-400 text-black text-[10px] font-bold leading-none shadow pointer-events-none'
      title='Not referenced anywhere'
    >
      !
    </span>
  );
}

export default UnreferencedBadge;
