import React from 'react';
import ClawBay from '../components/ClawBay';

export default function SkillMarket() {
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4">
        <h1 className="text-lg font-bold text-white">
          ⚡ Skill Market
        </h1>
        <p className="text-xs mt-0.5 text-slate-400">
          Discover, purchase and review AI skills
        </p>
      </div>
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <ClawBay collapsed={false} />
      </div>
    </div>
  );
}