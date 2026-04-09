from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity
import numpy as np

app = FastAPI(title="TruthLens Semantic Microservice")

# Load model globally to avoid loading per request
print("Loading all-MiniLM-L6-v2 model...")
model = SentenceTransformer('all-MiniLM-L6-v2')
print("Model loaded successfully.")

class AnalyzeRequest(BaseModel):
    main_text: str
    articles: List[str]

class AnalyzeResponse(BaseModel):
    similarities: List[float]

@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_similarity(request: AnalyzeRequest):
    try:
        # If there are no articles to compare, return empty array
        if not request.articles:
            return AnalyzeResponse(similarities=[])

        # Combine main text with articles for batch encoding
        texts = [request.main_text] + request.articles
        
        # Compute embeddings
        embeddings = model.encode(texts)
        
        # main_text is at index 0, articles start at index 1
        main_embedding = embeddings[0].reshape(1, -1)
        article_embeddings = embeddings[1:]
        
        # Compute cosine similarity
        similarities_matrix = cosine_similarity(main_embedding, article_embeddings)
        
        # Flatten and convert to list of floats
        similarity_scores = similarities_matrix[0].tolist()
        
        # Return clean JSON representation
        return {"similarities": similarity_scores}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
