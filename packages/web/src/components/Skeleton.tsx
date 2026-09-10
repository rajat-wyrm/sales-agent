import React from 'react';

interface SkeletonProps {
  className?: string;
}

export const Skeleton: React.FC<SkeletonProps> = ({ className = '' }) => (
  <div className={`animate-pulse bg-gray-200 rounded ${className}`} />
);

export const TableSkeleton: React.FC<{ rows?: number; cols?: number }> = ({ rows = 5, cols = 4 }) => (
  <div className="space-y-2">
    <div className="h-10 bg-gray-200 rounded animate-pulse" />
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="h-12 bg-gray-200 rounded animate-pulse flex gap-2">
        {Array.from({ length: cols }).map((_, j) => (
          <div key={j} className="h-full flex-1 bg-gray-300 rounded animate-pulse" />
        ))}
      </div>
    ))}
  </div>
);

export const StatCardSkeleton: React.FC = () => (
  <div className="bg-white p-6 rounded-lg shadow border animate-pulse">
    <div className="h-4 bg-gray-200 rounded w-3/4 mb-3" />
    <div className="h-8 bg-gray-300 rounded w-1/2" />
  </div>
);
