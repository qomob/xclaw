import { useState, useEffect, useCallback } from 'react';
import { searchSkills, fetchSkillDetail } from '../utils/api';

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  tags?: string[];
}

interface SkillDetail {
  id: string;
  name: string;
  description: string;
  category: string;
  version?: string;
  tags?: string[];
  price?: number;
  avg_rating?: number;
  review_count?: number;
  sales_count?: number;
  seller_name?: string;
}

export default function SkillExplorer({ collapsed = false }: { collapsed?: boolean }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [view, setView] = useState<'list' | 'detail'>('list');

  const handleSelectSkill = useCallback(async (skillId: string) => {
    setLoading(true);
    try {
      const data = await fetchSkillDetail(skillId);
      if (data.success) {
        setSelectedSkill(data.data);
        setView('detail');
      }
    } catch (error) {
      console.error('Failed to fetch skill detail:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleBack = useCallback(() => {
    setView('list');
    setSelectedSkill(null);
  }, []);

  const fetchSkills = useCallback(async (term: string = searchTerm) => {
    setLoading(true);
    try {
      const data = await searchSkills(term);
      if (data.success) {
        setSkills(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch skills:', error);
    } finally {
      setLoading(false);
    }
  }, [searchTerm]);

  useEffect(() => {
    // 仅在组件挂载时执行初始获取
    const init = async () => {
      try {
        const data = await searchSkills('');
        if (data.success) {
          setSkills(data.data);
        }
      } catch (error) {
        console.error('Failed to fetch skills:', error);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, []);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 pt-2">
        <span className="text-purple-400 text-lg">✧</span>
        <span className="text-[7px] text-gray-500 text-center leading-tight">SKILL<br />EXPLR</span>
        {loading ? (
          <span className="text-[7px] text-yellow-400 animate-pulse">···</span>
        ) : (
          <span className="text-[7px] text-cyan-400">{skills.length}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-slate-900/50 rounded-sm border border-[#1E293B] p-2 md:p-4">
      <h2 className="text-xs md:text-sm font-bold text-cyan-400 mb-2 md:mb-4 flex items-center gap-1 md:gap-2">
        <span className="text-purple-400 text-[10px] md:text-sm">✧</span> SKILL EXPLORER
      </h2>
      
      <div className="flex gap-1 md:gap-2 mb-3 md:mb-4">
        <input 
          type="text" 
          placeholder="Search skills (e.g. 'crypto', 'weather')..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && fetchSkills(searchTerm)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 md:px-3 py-1 text-[10px] md:text-xs text-white focus:border-cyan-500 outline-none"
        />
        <button 
          onClick={() => fetchSkills(searchTerm)}
          className="bg-cyan-600 hover:bg-cyan-700 text-white text-[9px] md:text-[10px] px-2 md:px-3 py-1 rounded transition-colors whitespace-nowrap"
        >
          SEARCH
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 md:space-y-3 pr-1">
        {view === 'detail' ? (
          selectedSkill ? (
            <div className="space-y-3 md:space-y-4">
              <button
                onClick={handleBack}
                className="text-[10px] md:text-xs text-cyan-400 hover:text-cyan-300 transition-colors mb-2"
              >
                ← Back
              </button>
              <div className="p-3 md:p-4 bg-slate-800/50 border border-slate-700">
                <div className="flex justify-between items-start mb-2">
                  <span className="text-xs md:text-sm font-bold text-cyan-400">{selectedSkill.name}</span>
                  <span className="text-[9px] md:text-[10px] bg-slate-700 px-1 md:px-1.5 py-0.5 rounded text-gray-400 uppercase">{selectedSkill.category}</span>
                </div>
                <p className="text-[9px] md:text-[10px] text-gray-400 mb-3">{selectedSkill.description}</p>
                <div className="space-y-1.5 md:space-y-2 text-[9px] md:text-[10px]">
                  {selectedSkill.version && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Version</span>
                      <span className="text-gray-300">{selectedSkill.version}</span>
                    </div>
                  )}
                  {selectedSkill.price !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Price</span>
                      <span className="text-cyan-400">{selectedSkill.price === 0 ? 'Free' : `${selectedSkill.price}`}</span>
                    </div>
                  )}
                  {selectedSkill.avg_rating !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Rating</span>
                      <span className="text-yellow-400">★ {selectedSkill.avg_rating.toFixed(1)} ({selectedSkill.review_count ?? 0})</span>
                    </div>
                  )}
                  {selectedSkill.sales_count !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Sales</span>
                      <span className="text-gray-300">{selectedSkill.sales_count}</span>
                    </div>
                  )}
                  {selectedSkill.seller_name && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Seller</span>
                      <span className="text-gray-300">{selectedSkill.seller_name}</span>
                    </div>
                  )}
                </div>
                {selectedSkill.tags && selectedSkill.tags.length > 0 && (
                  <div className="flex flex-wrap gap-0.5 md:gap-1 mt-3">
                    {selectedSkill.tags.map(tag => (
                      <span key={tag} className="text-[8px] md:text-[9px] text-cyan-500/70">#{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="text-center py-8 md:py-10 text-[10px] md:text-xs text-gray-500">Skill not found.</div>
          )
        ) : loading ? (
          <div className="text-center py-8 md:py-10 text-[10px] md:text-xs text-gray-500 animate-pulse">Scanning network...</div>
        ) : skills.length === 0 ? (
          <div className="text-center py-8 md:py-10 text-[10px] md:text-xs text-gray-500">No matching skills found.</div>
        ) : (
          skills.map(skill => (
            <div key={skill.id} onClick={() => handleSelectSkill(skill.id)} className="cursor-pointer p-2 md:p-3 bg-slate-800/50 border border-slate-700 hover:border-cyan-500/50 transition-all group">
              <div className="flex justify-between items-start mb-1">
                <span className="text-[10px] md:text-xs font-bold text-white group-hover:text-cyan-400 transition-colors">{skill.name}</span>
                <span className="text-[9px] md:text-[10px] bg-slate-700 px-1 md:px-1.5 py-0.5 rounded text-gray-400 uppercase">{skill.category}</span>
              </div>
              <p className="text-[9px] md:text-[10px] text-gray-400 line-clamp-2 mb-1.5 md:mb-2">{skill.description}</p>
              {skill.tags && skill.tags.length > 0 && (
              <div className="flex flex-wrap gap-0.5 md:gap-1">
                {skill.tags.map(tag => (
                  <span key={tag} className="text-[8px] md:text-[9px] text-cyan-500/70">#{tag}</span>
                ))}
              </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
