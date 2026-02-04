from flask import Flask, request, send_from_directory, jsonify
import sqlite3
import os

app = Flask(__name__)

@app.route('/<path:url>', methods=['GET', 'POST', 'PUT', 'DELETE'])

def handler(url):
    # 클라이언트 IP 주소
    client_ip = request.remote_addr

    # 요청 URL
    requested_url = request.url

    # 전체 헤더 정보
    headers = dict(request.headers)

    # 출력
    print(f'Client IP: {client_ip}')
    print(f'Requested URL: {requested_url}')
    print('Headers:')
    for key, value in headers.items():
        if key.lower() == 'cookie':  # 앞 20글자만 출력
            print(f'  {key}: {value[:20]}...')
        else:
            print(f'  {key}: {value}')
    print()
    print('==================')
    print()
    
    # 파일 경로 설정 (Flask 실행 디렉토리 기준)
    file_dir = os.path.join(os.getcwd(), 'src')

    # 파일이 존재하면 클라이언트에게 전송
    if 'verify_' in url:  # url()에 들어가는 문자열 캐치!
        return send_from_directory(file_dir, "ok.png")
    elif os.path.exists(os.path.join(file_dir, url)):
        return send_from_directory(file_dir, url)
    else:
        return jsonify({
            'error': 'File not found',
            'requested_file': url
        }), 404

def store_data(data):    
    # SQLite DB 연결 (없으면 생성됨)
    conn = sqlite3.connect("url_log.db")
    cursor = conn.cursor()

    # 테이블 생성 (없으면 생성됨)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL
        )
    """)

    # 문자열 삽입
    cursor.execute("INSERT INTO logs (content) VALUES (?)", (data,))

    # 변경사항 저장 및 연결 종료
    conn.commit()
    conn.close()



if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
