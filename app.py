from flask import Flask, send_from_directory
import os

app = Flask(__name__, static_folder=".", static_url_path="")


@app.route("/")
def home():
    # Serve the existing index.html in the project root
    return send_from_directory(os.path.dirname(os.path.abspath(__file__)), "index.html")


if __name__ == "__main__":
    app.run(debug=True)

